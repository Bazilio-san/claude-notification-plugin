# Installing via Claude Code Plugin Marketplace

Step-by-step visual guide for adding the marketplace and installing the plugin through the Claude Code UI.

## Step 1: Open the Plugin Manager

Type `/plugin` in Claude Code and navigate to the **Marketplaces** tab. Click **+ Add Marketplace**.

![Open Marketplaces tab and click Add Marketplace](img/img_1.png)

## Step 2: Add the Marketplace

Enter the marketplace source:

```
Bazilio-san/claude-plugins
```

Press **Enter** to add.

![Enter Bazilio-san/claude-plugins](img/img_2.png)

## Step 3: Marketplace Added

The **bazilio-plugins** marketplace now appears in the list.

![Marketplace added successfully](img/img_6.png)

## Step 4: Find the Plugin

Switch to the **Discover** tab. Select **claude-notification-plugin**.

![Discover tab with claude-notification-plugin](img/img_3.png)

## Step 5: Review Plugin Details

Review the plugin description and available actions.

![Plugin details page](img/img_4.png)

## Step 6: Install the Plugin

Select **Install for you (user scope)**.

![Install for you (user scope)](img/img_5.png)

## Step 7: Enable Auto-Update (recommended)

Go back to the **Marketplaces** tab, select **bazilio-plugins**, then choose **Enable auto-update**.

![Select the marketplace](img/img_7.png)

![Auto-update enabled confirmation](img/img_8.png)

## Step 8: Reload Plugins

Run `/reload-plugins` to activate the newly installed plugin.

![Run /reload-plugins](img/img_9.png)

## Step 9: Configure Telegram

Run the setup command to enter your Telegram bot token and chat ID:

```
/claude-notification-plugin:setup
```

![Run /claude-notification-plugin:setup](img/img_10.png)

See [Telegram Setup](README.md#telegram-setup) in the README for how to get your bot token and chat ID.
