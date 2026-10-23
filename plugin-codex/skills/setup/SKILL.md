---
name: setup
description: Set up the Email MCP plugin's local email server or change its private mailbox configuration, native binary or launcher paths.
---

<!-- Copyright (C) 2026 Marcus Hirt. See LICENSE for license details. -->

Configure the MCP server supplied by this plugin. Do not register a second server with `codex mcp add`
or edit global MCP settings to add another copy.

1. Locate the plugin root two directories above this skill's directory. Its launcher is
   `scripts/email-mcp.mjs`. Use that absolute path in commands; `${PLUGIN_ROOT}` is expanded by the
   plugin loader in `mcp.json`, not by the shell. Check that Node.js 18 or newer is available.
2. Run `node "<plugin-root>/scripts/email-mcp.mjs" --configure` to create a private, empty-credential
   default-account template outside the plugin. Repeating this command preserves existing settings.
   An optional `--binary "/absolute/path/to/native-executable"` selects a binary already installed.
   Do not open or read the unredacted configuration through model tools, request passwords in chat,
   or pass credentials as command-line arguments.
3. Tell the user to open the reported configuration file in their own editor and fill in the six
   `EMAIL_ACCOUNTS_DEFAULT_IMAP_HOST`, `..._IMAP_USERNAME`, `..._IMAP_PASSWORD`,
   `..._SMTP_HOST`, `..._SMTP_USERNAME`, and `..._SMTP_PASSWORD` string values. For more accounts,
   replace `DEFAULT` with distinct names such as `HOME` and `WORK`; remove unused empty account entries.
   Gmail requires an app password. Keep `EMAIL_ALLOW_SENDING` and `EMAIL_ALLOW_DELETION` set to `"false"`
   unless the user explicitly wants those capabilities enabled. A private configuration file contains
   plaintext passwords; keep it outside repositories and shared folders.
4. Run `node "<plugin-root>/scripts/email-mcp.mjs" --install` to download and verify the pinned native
   executable, or validate the selected existing executable. This does not connect to a mailbox and can
   run while the user edits credentials. It avoids a first download exceeding MCP startup timeouts.
5. Run `node "<plugin-root>/scripts/email-mcp.mjs" --show-config` only when a configuration check is useful.
   This command redacts every account password. Environment settings override saved settings:
   `EMAIL_MCP_BINARY` selects an existing executable, `EMAIL_MCP_CODEX_CONFIG` selects the config file,
   and `EMAIL_MCP_CODEX_CACHE` selects the download cache. Do not silently alter existing overrides.
6. Ask the user to restart the client or start a new Codex chat after editing configuration. Then discover
   this plugin's tools and call `listAccounts` to verify the account names. This is the setup check;
   do not read messages, mark messages read, send email or change mailbox state to test installation.
   If startup fails, report the launcher error and direct the user to their private editor for credential
   corrections. A successful `--install` proves the executable is ready, not mailbox connectivity.

If a manual Email MCP registration already exists, explain the duplicate and keep one active registration.
Do not remove an existing registration without the user's choice and verification of the plugin.
