# Email MCP for Codex

This portable plugin supplies the Email MCP server, setup and mailbox-workflow skills, and an icon.
It starts a local native executable through a dependency-free Node.js launcher; Node.js 18 or newer
must be available to the Codex process. No npm package or JVM is required.

Add the [AI Plugins marketplace](https://github.com/thegreystone/ai-plugins) to your Codex plugin sources,
refresh the directory, and install **Email MCP**. Its Codex entry selects this `plugin-codex/` directory.
Claude Code uses the separate [`plugin/`](../plugin/) package. The plugin supplies its MCP registration;
keep a single active registration if you previously added the server manually.

Run the plugin's **Setup** workflow. It creates an empty private mailbox configuration and prepares the
executable. Enter credentials in your own editor, then restart Codex or start a new chat and ask it to
list configured email accounts. No mailbox messages need to be read to verify setup.

## Private configuration

Use the actual installed plugin path:

```text
node "<plugin-root>/scripts/email-mcp.mjs" --configure
node "<plugin-root>/scripts/email-mcp.mjs" --install
node "<plugin-root>/scripts/email-mcp.mjs" --show-config
```

`--configure` reports the configuration file path and creates this template when none exists:

```json
{
  "env": {
    "EMAIL_ACCOUNTS_DEFAULT_IMAP_HOST": "",
    "EMAIL_ACCOUNTS_DEFAULT_IMAP_USERNAME": "",
    "EMAIL_ACCOUNTS_DEFAULT_IMAP_PASSWORD": "",
    "EMAIL_ACCOUNTS_DEFAULT_SMTP_HOST": "",
    "EMAIL_ACCOUNTS_DEFAULT_SMTP_USERNAME": "",
    "EMAIL_ACCOUNTS_DEFAULT_SMTP_PASSWORD": "",
    "EMAIL_ALLOW_SENDING": "false",
    "EMAIL_ALLOW_DELETION": "false"
  }
}
```

Open that file in your own editor and enter your provider's settings. Do not paste passwords into a chat
or pass them as command-line arguments. Gmail requires an app password. This file contains plaintext
passwords: keep it outside repositories and shared folders. The launcher creates new configuration
directories with mode `0700` and files with mode `0600` on Unix; Windows access follows your user profile's
ACLs. Repeating `--configure` preserves existing settings and credentials.

For multiple accounts, replace `DEFAULT` with names such as `HOME` and `WORK`, providing all six required
fields for each account. Remove unused empty account template entries. All configuration values inside
`env` must be strings. Optional fields for each `EMAIL_ACCOUNTS_<NAME>_` prefix are:

| Field | Meaning |
|-------|---------|
| `IMAP_PORT`, `IMAP_SSL` | IMAP port and implicit TLS; defaults are provider-sensitive (normally 993/TLS) |
| `SMTP_PORT`, `SMTP_STARTTLS`, `SMTP_SSL` | SMTP port and TLS; normally 587 with STARTTLS |
| `FROM` | Sender address or display name/address; defaults to SMTP username |
| `DRAFTS_FOLDER`, `SPAM_FOLDER`, `TRASH_FOLDER` | Override automatic special-folder discovery |

Global settings are `EMAIL_ALLOW_SENDING`, `EMAIL_ALLOW_DELETION` (`"true"` or `"false"`), and
`EMAIL_NETWORK_TIMEOUT` (nonnegative integer seconds as a string; the server defaults to 60).
Sending and permanent deletion default to false. The launcher rejects unknown saved settings and
incomplete accounts before starting the server. `--show-config` reports effective settings with every
account password replaced by `[REDACTED]`; configuration errors never include JSON contents.

Environment variables override saved settings. `EMAIL_MCP_CODEX_CONFIG` selects a different config file,
`EMAIL_MCP_CODEX_CACHE` selects another executable cache, and `EMAIL_MCP_BINARY` selects an existing native
executable instead of downloading one. These launcher controls are not mailbox settings inside `env`.
An existing native binary can also be saved with:

```text
node "<plugin-root>/scripts/email-mcp.mjs" --configure --binary "/absolute/path/to/email-server"
```

Default locations remain outside the installed plugin so updates preserve settings:

| Platform | Configuration | Binary cache |
|----------|---------------|--------------|
| Windows | `%LOCALAPPDATA%\email-mcp\codex\config.json` | `%LOCALAPPDATA%\email-mcp\cache` |
| macOS | `~/Library/Application Support/email-mcp/codex/config.json` | `~/Library/Caches/email-mcp` |
| Linux | `~/.config/email-mcp/codex/config.json` | `~/.cache/email-mcp` |

Linux respects `XDG_CONFIG_HOME` and `XDG_CACHE_HOME`; Windows falls back to `~/AppData/Local`.
The server runs in a writable `runtime/` directory beside the launcher configuration, with both its
working directory and `user.dir` set there. Its relative log file is written there. Launcher diagnostics
go to stderr; stdout remains the MCP transport.

## Native release

The launcher pins release **1.0.14** from `thegreystone/email-mcp`. That published release still uses
the artifact prefix **`mcp-email-server`**, independently of the repository's new name:

| Host | Native asset |
|------|--------------|
| Linux x86_64 | `mcp-email-server-1.0.14-linux-x86_64` |
| Linux ARM64 | `mcp-email-server-1.0.14-linux-aarch64` |
| macOS ARM64 | `mcp-email-server-1.0.14-macos-aarch64` |
| Windows x86_64 | `mcp-email-server-1.0.14-windows-x86_64.exe` |

Intel Macs, Windows ARM64 and other unsupported hosts receive an explicit error; use `EMAIL_MCP_BINARY`
for a compatible native executable you built yourself. Architecture detection handles Rosetta and
Windows emulation rather than choosing an incompatible binary from the Node process architecture.

`--install` downloads and verifies the executable without requiring account credentials or connecting to
a mailbox. Run it before restarting because an initial download can exceed the MCP startup timeout.
The launcher follows only official GitHub HTTPS hosts, verifies asset size and GitHub's SHA-256 digest
when provided, and rechecks a recorded hash before using cached binaries. Concurrent installations share
a lock; cancellation removes incomplete downloads. Closing MCP stdin or terminating the launcher stops
the child server.

After publishing a new release, update `RELEASE_VERSION`, `RELEASE_ARTIFACT_PREFIX` in
`scripts/email-mcp.mjs`, and `version` in `plugin.json`. Verify all four native assets before changing
the pin. New releases may use `email-mcp-server`; do not infer the artifact prefix from the repository
name. The Claude plugin's bundle URL is a separate release pin.

Run local launcher tests, which use mock transports and temporary files without mailbox access:

```text
node --check plugin-codex/scripts/email-mcp.mjs
node --test plugin-codex/tests/launcher.test.mjs
```
