# Contributing to Slash

We welcome contributions to the Slash Desktop client, shared packages, and local ecosystem! Here are a few ways to get involved:

## How to Contribute

1. **Reporting Bugs**: Open an issue describing the bug, including your operating system, version of Slash, steps to reproduce, and screenshots if applicable.
2. **Suggesting Enhancements**: Feel free to submit ideas for new features or improvements.
3. **Pull Requests**:
   - Fork the repository.
   - Create a feature branch (`git checkout -b feature/cool-new-thing`).
   - Write clean, well-tested code.
   - Run tests and linters locally before submitting.
   - Open a pull request against our mirroring branch.

## Local Development Setup

To build and run the Desktop application locally:

```bash
# Install dependencies
pnpm install

# Run Desktop client in dev mode
pnpm --filter tauri-appslash dev
```

Note that during the beta program, the collaborative server is hosted and private, so server-specific modifications cannot be accepted directly on this public mirror. All changes must be synced from the main project.
