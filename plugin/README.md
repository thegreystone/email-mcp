# Email MCP for Claude Code

Read, search, organize and draft email from your IMAP accounts. This plugin provides the email skill and
downloads the native MCP server from a pinned GitHub release. Sending and deletion are disabled by default;
drafting remains available.

Install from the [AI Plugins marketplace](https://github.com/thegreystone/ai-plugins):

```text
/plugin marketplace add thegreystone/ai-plugins
/plugin install email-mcp@hirt-ai-plugins
```

Open `/plugin`, choose **email-mcp** on the **Installed** tab, and choose **Configure**. Enter the IMAP
server, username and password, and the SMTP server, username and password. SMTP settings are required even
when sending is disabled. Enter credentials in this configuration form, never in a chat message. For Gmail,
use an App Password. Leave **Allow sending** and **Allow permanent deletion** off unless you want those
operations available. Start a new session, then ask the assistant to list the configured accounts.

The universal MCP Bundle supports macOS Apple silicon and Windows x86_64 and configures one account named
`default` with IMAP TLS on port 993 and SMTP STARTTLS on port 587. For Linux, several accounts, custom ports,
or other TLS settings, use the [manual configuration](../README.md#configuration) with the standalone native
binary. Claude Desktop does not accept this URL-based plugin: install its per-platform `.mcpb` directly
from [Releases](https://github.com/thegreystone/email-mcp/releases).

This directory contains no executable. The bundle URL in `.claude-plugin/plugin.json` pins release
`1.0.14`, whose assets still use the `mcp-email-server` filename prefix. The bundle identity remains
`mcp-email` so existing installations retain their settings. The plugin manifest intentionally omits a
version so marketplace updates track the source commit. After a new native release has been published and
signed, update the bundle URL to its exact version and filename; see [plugin maintenance](../docs/PLUGINS.md#maintaining-the-release-pins).

If you already registered the server manually, keep a single active registration after verifying the
plugin works. See [the plugin guide](../docs/PLUGINS.md) for Codex installation and configuration details.
