#!/usr/bin/env node

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Manages git worktrees for projects.
 */
export class WorktreeManager {
  constructor (config, logger) {
    this.config = config;
    this.logger = logger;
    const baseDir = config.listener?.worktreeBaseDir || path.join(os.homedir(), '.claude', 'worktrees');
    this.baseDir = baseDir.replace(/^~/, os.homedir());
  }

  /**
   * Discover existing worktrees for a project by running `git worktree list`.
   * Updates config.listener.projects[alias].worktrees in-place.
   */
  discoverWorktrees (projectAlias) {
    const project = this.config.listener?.projects?.[projectAlias];
    if (!project?.path) {
      return {};
    }
    const projectPath = this._resolvePath(project.path);
    if (!fs.existsSync(projectPath)) {
      return project.worktrees || {};
    }

    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: projectPath,
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 5000,
      });

      const worktrees = {};
      let currentPath = null;
      let currentBranch = null;

      for (const line of output.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.substring('worktree '.length).trim();
          currentBranch = null;
        } else if (line.startsWith('branch ')) {
          const ref = line.substring('branch '.length).trim();
          // refs/heads/feature/auth → feature/auth
          currentBranch = ref.replace(/^refs\/heads\//, '');
        } else if (line === '' && currentPath && currentBranch) {
          // Skip the main worktree (same path as project)
          const normalizedCurrent = path.resolve(currentPath);
          const normalizedProject = path.resolve(projectPath);
          if (normalizedCurrent !== normalizedProject) {
            worktrees[currentBranch] = currentPath;
          }
          currentPath = null;
          currentBranch = null;
        }
      }

      // Handle last entry
      if (currentPath && currentBranch) {
        const normalizedCurrent = path.resolve(currentPath);
        const normalizedProject = path.resolve(projectPath);
        if (normalizedCurrent !== normalizedProject) {
          worktrees[currentBranch] = currentPath;
        }
      }

      // Merge with existing config (keep manually configured paths)
      if (!project.worktrees) {
        project.worktrees = {};
      }
      for (const [branch, wtPath] of Object.entries(worktrees)) {
        if (!project.worktrees[branch]) {
          project.worktrees[branch] = wtPath;
        }
      }

      this.logger.info(`Discovered worktrees for "${projectAlias}": ${JSON.stringify(worktrees)}`);
      return project.worktrees;
    } catch (err) {
      this.logger.error(`Failed to discover worktrees for "${projectAlias}": ${err.message}`);
      return project.worktrees || {};
    }
  }

  /**
   * Create a new worktree for a project.
   */
  createWorktree (projectAlias, branch) {
    const project = this.config.listener?.projects?.[projectAlias];
    if (!project?.path) {
      throw new Error(`Project "${projectAlias}" not found`);
    }
    const projectPath = this._resolvePath(project.path);
    if (!fs.existsSync(projectPath)) {
      throw new Error(`Project path does not exist: ${projectPath}`);
    }

    // Sanitize branch for directory name
    const dirName = branch.replace(/\//g, '-');
    const wtDir = path.join(this.baseDir, projectAlias, dirName);

    if (fs.existsSync(wtDir)) {
      // Worktree directory already exists — just register it
      if (!project.worktrees) {
        project.worktrees = {};
      }
      project.worktrees[branch] = wtDir;
      return wtDir;
    }

    fs.mkdirSync(path.dirname(wtDir), { recursive: true });

    // Check if branch exists
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify "${branch}"`, {
        cwd: projectPath,
        encoding: 'utf-8',
        windowsHide: true,
        stdio: 'pipe',
        timeout: 5000,
      });
      branchExists = true;
    } catch {
      // branch doesn't exist
    }

    try {
      if (branchExists) {
        execSync(`git worktree add "${wtDir}" "${branch}"`, {
          cwd: projectPath,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: 'pipe',
          timeout: 30000,
        });
      } else {
        execSync(`git worktree add -b "${branch}" "${wtDir}"`, {
          cwd: projectPath,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: 'pipe',
          timeout: 30000,
        });
      }
    } catch (err) {
      throw new Error(`Failed to create worktree: ${err.message}`);
    }

    if (!project.worktrees) {
      project.worktrees = {};
    }
    project.worktrees[branch] = wtDir;

    this.logger.info(`Created worktree for "${projectAlias}": ${branch} → ${wtDir}`);
    return wtDir;
  }

  /**
   * Remove a worktree.
   */
  removeWorktree (projectAlias, branch) {
    const project = this.config.listener?.projects?.[projectAlias];
    if (!project?.path) {
      throw new Error(`Project "${projectAlias}" not found`);
    }
    const projectPath = this._resolvePath(project.path);

    const wtDir = project.worktrees?.[branch];
    if (!wtDir) {
      throw new Error(`Worktree "${branch}" not found for project "${projectAlias}"`);
    }

    try {
      execSync(`git worktree remove "${wtDir}" --force`, {
        cwd: projectPath,
        encoding: 'utf-8',
        windowsHide: true,
        stdio: 'pipe',
        timeout: 10000,
      });
    } catch (err) {
      this.logger.warn(`git worktree remove failed: ${err.message}, removing directory manually`);
      try {
        fs.rmSync(wtDir, { recursive: true, force: true });
        execSync('git worktree prune', {
          cwd: projectPath,
          encoding: 'utf-8',
          windowsHide: true,
          stdio: 'pipe',
          timeout: 5000,
        });
      } catch (err2) {
        throw new Error(`Failed to remove worktree directory: ${err2.message}`);
      }
    }

    delete project.worktrees[branch];
    this.logger.info(`Removed worktree for "${projectAlias}": ${branch}`);
  }

  /**
   * List all worktrees for a project (including main).
   */
  listWorktrees (projectAlias) {
    const project = this.config.listener?.projects?.[projectAlias];
    if (!project?.path) {
      return null;
    }

    // Discover fresh from git
    this.discoverWorktrees(projectAlias);

    const result = {
      main: this._resolvePath(project.path),
      worktrees: {},
    };
    if (project.worktrees) {
      for (const [branch, wtPath] of Object.entries(project.worktrees)) {
        result.worktrees[branch] = this._resolvePath(wtPath);
      }
    }
    return result;
  }

  /**
   * Resolve a workDir for a project + optional branch.
   * If branch is null, returns main worktree path.
   * If autoCreateWorktree is true, creates missing worktrees.
   */
  resolveWorkDir (projectAlias, branch) {
    const project = this.config.listener?.projects?.[projectAlias];
    if (!project?.path) {
      throw new Error(`Project "${projectAlias}" not found. Use /projects to see available projects.`);
    }

    if (!branch) {
      return this._resolvePath(project.path);
    }

    // Check existing worktrees
    if (project.worktrees?.[branch]) {
      const resolved = this._resolvePath(project.worktrees[branch]);
      if (fs.existsSync(resolved)) {
        return resolved;
      }
      // Path no longer exists, clean up
      delete project.worktrees[branch];
    }

    // Try auto-discover
    this.discoverWorktrees(projectAlias);
    if (project.worktrees?.[branch]) {
      return this._resolvePath(project.worktrees[branch]);
    }

    // Auto-create if enabled
    const autoCreate = this.config.listener?.autoCreateWorktree !== false;
    if (autoCreate) {
      return this.createWorktree(projectAlias, branch);
    }

    throw new Error(
      `Worktree "${branch}" not found for project "${projectAlias}". `
      + `Create it: /worktree /${projectAlias}/${branch}`
    );
  }

  _resolvePath (p) {
    return path.resolve(p.replace(/^~/, os.homedir()));
  }
}
