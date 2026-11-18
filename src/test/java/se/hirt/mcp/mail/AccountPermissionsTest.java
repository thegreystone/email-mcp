/*
 * Copyright (C) 2026 Marcus Hirt
 *
 * This software is free:
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. The name of the author may not be used to endorse or promote products
 *    derived from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESSED OR
 * IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 * OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 * IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
 * INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 * NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */
package se.hirt.mcp.mail;

import io.quarkiverse.mcp.server.ToolCallException;
import io.smallrye.config.EnvConfigSource;
import io.smallrye.config.SmallRyeConfigBuilder;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Sending and deletion are decided per account: the account's own setting when it has one, the
 * server-wide one otherwise. No server is needed; the gates run before any connection.
 */
class AccountPermissionsTest {

	private static final Optional<Boolean> UNSET = Optional.empty();
	private static final Optional<Boolean> ON = Optional.of(true);
	private static final Optional<Boolean> OFF = Optional.of(false);

	@Test
	void unsetAccountFollowsTheServerWideSetting() {
		assertDoesNotThrow(() -> tools(true, true, account(UNSET, UNSET)).requireSendingAllowed("home", "sendEmail"));
		assertDoesNotThrow(
				() -> tools(true, true, account(UNSET, UNSET)).requireDeletionAllowed("home", "deleteEmail"));
		var tools = tools(false, false, account(UNSET, UNSET));
		assertThrows(ToolCallException.class, () -> tools.requireSendingAllowed("home", "sendEmail"));
		assertThrows(ToolCallException.class, () -> tools.requireDeletionAllowed("home", "deleteEmail"));
	}

	@Test
	void accountCanBeEnabledWhenTheServerIsOff() {
		var tools = tools(false, false, account(ON, ON));
		assertDoesNotThrow(() -> tools.requireSendingAllowed("home", "sendEmail"));
		assertDoesNotThrow(() -> tools.requireDeletionAllowed("home", "deleteEmail"));
	}

	@Test
	void accountCanBeDisabledWhenTheServerIsOn() {
		var tools = tools(true, true, account(OFF, OFF));
		var send = assertThrows(ToolCallException.class, () -> tools.requireSendingAllowed("home", "replyEmail"));
		assertEquals("Error: replyEmail is disabled for account 'home'. Outbound email sending is turned off for this "
				+ "account by EMAIL_ACCOUNTS_HOME_ALLOW_SENDING=false, which takes precedence over EMAIL_ALLOW_SENDING. "
				+ "Until then, use saveDraft to put the message in the Drafts folder so the user can review and send "
				+ "it manually from their mail client.", send.getMessage());
		var delete = assertThrows(ToolCallException.class, () -> tools.requireDeletionAllowed("home", "deleteEmail"));
		assertTrue(delete.getMessage().contains("EMAIL_ACCOUNTS_HOME_ALLOW_DELETION=false, which takes precedence"),
				delete.getMessage());
	}

	@Test
	void sendingAndDeletionAreIndependent() {
		var tools = tools(false, false, account(ON, UNSET));
		assertDoesNotThrow(() -> tools.requireSendingAllowed("home", "sendEmail"));
		assertThrows(ToolCallException.class, () -> tools.requireDeletionAllowed("home", "deleteEmail"));
	}

	@Test
	void onlyTheNamedAccountIsAffected() {
		var tools = tools(false, false, Map.of("home", account(ON, UNSET), "work", account(UNSET, UNSET)));
		assertDoesNotThrow(() -> tools.requireSendingAllowed("home", "sendEmail"));
		var e = assertThrows(ToolCallException.class,
				() -> tools.sendEmail("work", "to@example.com", "", "", "Subject", "Body"));
		assertEquals("Error: sendEmail is disabled for account 'work'. Outbound email sending is opt-in for safety. "
				+ "To enable it, the server administrator must set EMAIL_ACCOUNTS_WORK_ALLOW_SENDING=true for this "
				+ "account only, or EMAIL_ALLOW_SENDING=true (or -Demail.allow-sending=true) for every account, and "
				+ "restart the server. Until then, use saveDraft to put the message in the Drafts folder so the user "
				+ "can review and send it manually from their mail client.", e.getMessage());
	}

	@Test
	void unknownAccountIsReportedAsSuch() {
		var tools = tools(true, true, account(UNSET, UNSET));
		var e = assertThrows(ToolCallException.class, () -> tools.forwardEmail("nope", "INBOX", 1, "to@example.com"));
		assertTrue(e.getMessage().startsWith("Error forwarding: Unknown account: nope"), e.getMessage());
	}

	@Test
	void listAccountsReportsTheEffectivePermissionsOfEachAccount() {
		var tools = tools(false, true, Map.of("work", account(ON, UNSET), "home", account(UNSET, OFF)));
		assertEquals("Configured accounts: home, work\n" + "home: sending disabled, deletion disabled\n"
				+ "work: sending enabled, deletion enabled", tools.listAccounts());
	}

	@Test
	void listAccountsWithoutAccounts() {
		assertEquals("No email accounts configured.", tools(true, true, Map.of()).listAccounts());
	}

	@Test
	void accountVariableFollowsTheEnvironmentNamingRule() {
		assertEquals("EMAIL_ACCOUNTS_HOME_ALLOW_SENDING", EmailTools.accountVariable("home", "ALLOW_SENDING"));
		assertEquals("EMAIL_ACCOUNTS_MY_WORK_ALLOW_DELETION", EmailTools.accountVariable("my-work", "ALLOW_DELETION"));
	}

	/**
	 * The account map is keyed by a name taken from the middle of the variable, so check that the
	 * new names map onto the account and leave the server-wide variables alone.
	 */
	@Test
	void environmentVariablesMapOntoTheAccount() {
		var env = new HashMap<String, String>();
		for (var name : new String[] {"HOME", "WORK"}) {
			env.put("EMAIL_ACCOUNTS_" + name + "_IMAP_HOST", "imap.example.com");
			env.put("EMAIL_ACCOUNTS_" + name + "_IMAP_USERNAME", "user");
			env.put("EMAIL_ACCOUNTS_" + name + "_IMAP_PASSWORD", "secret");
			env.put("EMAIL_ACCOUNTS_" + name + "_SMTP_HOST", "smtp.example.com");
			env.put("EMAIL_ACCOUNTS_" + name + "_SMTP_USERNAME", "user");
			env.put("EMAIL_ACCOUNTS_" + name + "_SMTP_PASSWORD", "secret");
		}
		env.put("EMAIL_ACCOUNTS_HOME_ALLOW_SENDING", "true");
		env.put("EMAIL_ACCOUNTS_HOME_ALLOW_DELETION", "false");
		env.put("EMAIL_ALLOW_SENDING", "false");
		env.put("EMAIL_ALLOW_DELETION", "true");
		var config = new SmallRyeConfigBuilder().withSources(new EnvConfigSource(env, 300))
				.withMapping(EmailConfig.class).build();

		var accounts = config.getConfigMapping(EmailConfig.class).accounts();
		assertEquals(Set.of("home", "work"), accounts.keySet());
		assertEquals(ON, accounts.get("home").allowSending());
		assertEquals(OFF, accounts.get("home").allowDeletion());
		assertEquals(UNSET, accounts.get("work").allowSending());
		assertEquals(UNSET, accounts.get("work").allowDeletion());
		assertEquals(false, config.getValue("email.allow-sending", Boolean.class));
		assertEquals(true, config.getValue("email.allow-deletion", Boolean.class));
	}

	// ── helpers ─────────────────────────────────────────────────────────

	private static EmailTools tools(boolean allowSending, boolean allowDeletion, EmailConfig.AccountConfig home) {
		return tools(allowSending, allowDeletion, Map.of("home", home));
	}

	private static EmailTools tools(
		boolean allowSending, boolean allowDeletion, Map<String, EmailConfig.AccountConfig> accounts) {
		var service = new EmailService();
		service.config = new EmailConfig() {
			public Map<String, AccountConfig> accounts() {
				return accounts;
			}

			public int networkTimeout() {
				return 1;
			}
		};
		var tools = new EmailTools();
		tools.emailService = service;
		tools.allowSending = allowSending;
		tools.allowDeletion = allowDeletion;
		return tools;
	}

	/** An account with only the permission settings; any connection attempt would fail. */
	static EmailConfig.AccountConfig account(Optional<Boolean> allowSending, Optional<Boolean> allowDeletion) {
		return new EmailConfig.AccountConfig() {
			public EmailConfig.ImapConfig imap() {
				return null;
			}

			public EmailConfig.SmtpConfig smtp() {
				return null;
			}

			public Optional<String> from() {
				return Optional.empty();
			}

			public Optional<String> draftsFolder() {
				return Optional.empty();
			}

			public Optional<String> spamFolder() {
				return Optional.empty();
			}

			public Optional<String> trashFolder() {
				return Optional.empty();
			}

			public Optional<Boolean> allowSending() {
				return allowSending;
			}

			public Optional<Boolean> allowDeletion() {
				return allowDeletion;
			}
		};
	}
}
