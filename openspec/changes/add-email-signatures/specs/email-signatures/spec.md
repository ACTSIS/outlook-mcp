# Email Signatures Specification

## Requirements

### Requirement: Signature Lifecycle

The system MUST create, list, retrieve, update, and delete named HTML signatures with optional images. Mutations MUST validate before changing state.

#### Scenario: Complete lifecycle

- GIVEN a valid signature
- WHEN it is created, listed, retrieved, updated, and deleted
- THEN each result MUST reflect that lifecycle stage

#### Scenario: Invalid mutation

- GIVEN a duplicate, missing target, or invalid candidate
- WHEN mutation is requested
- THEN it MUST fail without state changes

### Requirement: Shared Default

The system MUST maintain one optional default shared by every email flow.

#### Scenario: Set default

- GIVEN a stored signature
- WHEN selected as default
- THEN it MUST become the sole default

#### Scenario: Delete default

- GIVEN the default signature
- WHEN it is deleted
- THEN deletion MUST succeed and clear the default

#### Scenario: Unknown default

- GIVEN an unknown signature name
- WHEN selected as default
- THEN it MUST fail and preserve the default

### Requirement: Safe HTML

The system MUST allowlist HTML and MUST NOT retain executable markup, event handlers, remote URLs, or `data:` images.

#### Scenario: Sanitize unsafe markup

- GIVEN allowed formatting mixed with executable content
- WHEN saved
- THEN allowed content MUST remain and unsafe content be removed

#### Scenario: Reject external image

- GIVEN a remote or `data:` image source
- WHEN saved
- THEN it MUST fail without state changes

### Requirement: Managed CID Images

Each `cid:` MUST bind one base64 image with supported type and unique ID. Invalid or unbound entries MUST be rejected.

#### Scenario: Valid binding

- GIVEN one CID and one valid matching image
- WHEN saved
- THEN both MUST be accepted together

#### Scenario: Invalid binding

- GIVEN an unresolved, duplicate, malformed, or unreferenced image
- WHEN saved
- THEN it MUST fail without state changes

### Requirement: Durable Private Storage

Signature state MUST be separate from authentication, private, atomically replaced, and mutation-serialized. Failures MUST preserve prior state.

#### Scenario: Concurrent mutations

- GIVEN overlapping valid mutations
- WHEN they complete
- THEN updates MUST serialize without corruption or loss

#### Scenario: Persistence failure

- GIVEN valid stored state
- WHEN persistence fails
- THEN the operation MUST fail and preserve that state
