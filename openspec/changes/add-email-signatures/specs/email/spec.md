# Delta for Email

## ADDED Requirements

### Requirement: Signature Resolution

Operations MUST resolve `includeSignature: false`, then `signatureName`, then the default. Without one they MUST remain unsigned.

#### Scenario: Opt-out wins

- GIVEN a default and named override
- WHEN `includeSignature: false` is set
- THEN no signature content MUST be included

#### Scenario: Override wins

- GIVEN a default and different stored `signatureName`
- WHEN signing is requested
- THEN the named signature MUST replace the default

#### Scenario: Default fallback

- GIVEN no override or opt-out
- WHEN processing runs
- THEN it MUST use the default, or remain unsigned if absent

#### Scenario: Unknown override

- GIVEN an unknown `signatureName`
- WHEN processing is requested
- THEN it MUST fail before sending or saving

### Requirement: Four-Flow Composition

The signature MUST follow the body once as HTML in new send, native reply send, new draft, and native reply draft while preserving body and thread.

#### Scenario: All four flows

- GIVEN a resolved signature and valid `replyToId` where required
- WHEN each supported send or draft flow runs
- THEN body and threading MUST remain with one signature

### Requirement: Inline Signature Delivery

Images MUST attach inline with bound CIDs. Operations MUST NOT fetch remote images.

#### Scenario: Attach CID images

- GIVEN a signature with two managed CID images
- WHEN any email flow completes
- THEN both MUST be inline attachments matching HTML CIDs

#### Scenario: Composition failure

- GIVEN resolution, composition, or attachment fails
- WHEN send or draft is attempted
- THEN it MUST report failure and MUST NOT send
