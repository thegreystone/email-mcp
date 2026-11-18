# Email MCP plugins

The [AI Plugins marketplace](https://github.com/thegreystone/ai-plugins) offers separate packages for
Claude Code and Codex. Both run the native Email MCP server locally. Mailbox credentials stay in local
client settings or a configuration file outside the plugin installation; enter passwords there, never in
chat or source control. The server connects to your IMAP and SMTP providers to perform the requested work.

## Claude Code

```text
/plugin marketplace add thegreystone/ai-plugins
/plugin install email-mcp@hirt-ai-plugins
```

Open `/plugin`, choose **email-mcp** on the **Installed** tab, and choose **Configure**. Fill in the six
required IMAP and SMTP fields: server, username and password for each protocol. SMTP configuration is
required even when sending is disabled. For Gmail use an App Password. Keep **Allow sending** and **Allow
permanent deletion** off for the default workflow of reading, organizing and preparing drafts.

Start a new Claude Code session and ask it to list the configured accounts. The bundle configures one
account named `default`. Its default connections are IMAP TLS on port 993 and SMTP STARTTLS on port 587.
The plugin skill discovers the tool namespace and calls `listAccounts` before mailbox operations.

The Claude package in [`plugin/`](../plugin/) references a universal MCP Bundle by URL. That bundle supports
macOS Apple silicon and Windows x86_64. Linux, multiple accounts, custom ports and other TLS settings use
the [standalone server and manual configuration](../README.md#configuration).

Claude Desktop does not accept this URL-based plugin. Download its per-platform `.mcpb` from
[Releases](https://github.com/thegreystone/email-mcp/releases) and follow the
[Desktop instructions](../README.md#setting-up-with-claude-desktop).

## Codex

Add `thegreystone/ai-plugins` as a plugin source in Codex, refresh the directory, and install **Email MCP**.
The Codex marketplace entry selects [`plugin-codex/`](../plugin-codex/), which supplies the MCP registration,
email skill and setup workflow. Requires Node.js 18 or newer on the Codex process's PATH; no npm package
installation is needed.

Run the plugin's **Setup** workflow. Its launcher creates an account template in a local JSON configuration
file outside the plugin installation. Edit that file privately to fill in IMAP and SMTP credentials, or
provide the equivalent `EMAIL_ACCOUNTS_<NAME>_*` environment variables to the Codex process. Add another
named account by adding its six required variables; remove unused empty account templates. Every configured
account needs complete IMAP and SMTP settings. The launcher supports ports, TLS options, special-folder settings
and network timeout. Sending and deletion remain disabled unless explicitly enabled in your configuration.

The JSON file contains plaintext credentials when you save passwords there. Keep it private and outside
source control. Launcher configuration reports redact password fields; never paste the file into chat.
Existing email environment variables take precedence over saved values.

Run the setup download before restarting so the first native download does not exceed the MCP startup
timeout. Then start a new Codex chat or restart the client and ask it to list the configured accounts.
Listing accounts confirms that the server loaded its configuration; reading mail on request checks the
connection to the provider. Setup does not read mailbox content or send messages.

The launcher supports Linux x86_64 and ARM64, macOS Apple silicon, and Windows x86_64. It detects the native
host architecture, including Apple silicon under Rosetta. Unsupported platforms produce an explicit error.
Use `EMAIL_MCP_BINARY` for a compatible native executable you built or installed yourself. The launcher
stores downloaded binaries in a versioned cache outside the plugin directory, verifies the published size
and SHA-256 digest when available, and checks the cached file before use.

`EMAIL_MCP_CODEX_CONFIG` selects another local configuration file and `EMAIL_MCP_CODEX_CACHE` selects
another executable cache. Plugin updates preserve both. See the
[Codex package README](../plugin-codex/README.md) for launcher commands and default paths.

Both packages supply their own MCP registration. If you already registered Email MCP manually, verify the
plugin works and keep a single active registration to avoid duplicate tools.

The package layouts follow the [Claude plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
and [OpenAI plugin packaging guide](https://developers.openai.com/plugins/build/plugins).

## Maintaining the release pins

Both plugin packages pin release **1.0.15**:

- Claude uses `email-mcp-server-1.0.15-universal.mcpb` from that release.
- Codex selects `email-mcp-server-1.0.15-<platform>` from the same release.

After each release has been published and signed (including the Windows signing and the universal bundle
re-pack), update the version in the Claude bundle URL, the Codex launcher's `RELEASE_VERSION`, the Codex
manifest version and the package documentation together. Confirm that every supported native asset and the
universal bundle exist before updating the marketplace packages. Releases up to 1.0.14 predate the artifact
rename and use the `mcp-email-server` filename prefix; `RELEASE_ARTIFACT_PREFIX` in the Codex launcher
only needs changing to pin one of those.

The Claude manifest intentionally omits a version so its Git subdirectory package follows source commits.
Its bundle URL pins the server separately. The bundle identity stays `mcp-email` to preserve installed
extension settings. To update the Claude package, run `claude plugin update email-mcp@hirt-ai-plugins`.

Keep `plugin/assets/icon.png` and `plugin-codex/assets/icon.png` synchronized with
[`docs/assets/email-mcp-icon.png`](assets/email-mcp-icon.png). Native executables and `.mcpb` files belong in
GitHub Releases and local caches, not in the plugin source directories. Neither package needs npm
publication.

Validate the Codex launcher without mailbox access:

```text
node --check plugin-codex/scripts/email-mcp.mjs
node --test plugin-codex/tests/launcher.test.mjs
```

When Claude Code is installed, validate its package locally with:

```text
claude plugin validate ./plugin
```
