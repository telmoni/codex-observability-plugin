.PHONY: check
# The gate: types, the bundle and the suites, the manifests and the package
# among them, since Codex ships no validator for a plugin or a marketplace.
# Needs Node 22.18, 24.11 or 26+, and npm.
check:
	npm run verify
