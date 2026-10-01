// Empty stand-in for the `server-only` package under vitest.
//
// The real package throws when bundled into a client graph — that is the
// build-time guard `src/lib/wireOutput.ts` wants from Next. Unit tests import
// the narrowers outside any bundler, so `vitest.config.mts` aliases the
// package here to keep them running while `make build` enforces the boundary.
export {};
