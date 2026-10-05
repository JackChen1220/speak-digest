# Security Policy

## Supported versions

Speak Digest is a small GitHub-only project. Security fixes are made on the latest code on `main` and, when releases are published, the latest GitHub release. Older snapshots are not supported.

## Report a vulnerability privately

Do not publish vulnerability details, exposed credentials, private video information, or transcript data through a public issue or pull request. This repository does not accept public security reports.

Use GitHub's private vulnerability reporting flow from this repository's **Security** tab when it is available. If the private reporting link is not visible, contact the repository owner through their GitHub profile and ask for a private reporting channel without including vulnerability details in the public message. Include the following only in the private report:

- the affected version or commit;
- the minimum steps needed to reproduce the problem;
- the expected and observed behavior;
- the security and privacy impact; and
- a suggested fix, if you have one.

Remove real API keys, access tokens, private URLs, transcripts, notes, and personal information. Use redacted values and public test content.

There is no guaranteed response time or bug-bounty program. Please allow a reasonable period for investigation and remediation before public disclosure.

## High-priority issues

Examples include:

- API keys or private content included in source, logs, screenshots, or release ZIPs;
- requests to network origins outside the documented YouTube, Supadata, DeepSeek, optional Tavily, and Youdao dictionary hosts;
- script or HTML injection through transcript, metadata, service errors, or model output;
- access to browsing data outside the documented YouTube scope;
- unintended transmission of notes, transcripts, or credentials;
- a dependency or release-workflow compromise; and
- bypasses of local data deletion or DeepSeek configuration controls.

Transcript text, video metadata, web results, and model output are untrusted data. Provider output must not be treated as instructions or executable markup. Tavily source URLs must be validated source URLs before rendering; all displayed text must be escaped, and transcript, conversation, search, storage, and rendering work must remain bounded.

The side panel and message relay use the active YouTube tab only and fail closed on other pages. Transcript search is bounded literal string matching, not a user-built regular expression, and its marks must preserve escaped content and existing Vocabulary highlights.

Vocabulary pronunciation builds a fixed `dict.youdao.com` audio URL from a bounded English term and requests it only after a click. The request does not include API keys, notes, or transcript context. On failure it falls back to browser `speechSynthesis`, whose selected voice may be online; non-English terms use browser speech directly. No dictionary audio is stored by the extension.

## User security guidance

- Install only from a GitHub source or release you trust.
- Review changes and the packaged file list before loading an update.
- Use dedicated, scoped API keys where possible and set provider spending limits.
- Do not reuse keys from production systems.
- Revoke keys immediately if a device, browser profile, ZIP, log, or screenshot exposes them.
- Remember that API keys are kept in Chrome local extension storage, which is not an encrypted password vault.

The release tooling uses an explicit file allowlist and scans public files for common credential patterns, but automated checks cannot detect every secret.
