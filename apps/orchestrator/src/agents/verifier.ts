// apps/orchestrator/src/agents/verifier.ts
// Compatibility entry point: the verification implementation lives in ../verify/runner.ts.
// The adapter keeps the original import path used by the Phase 2 tests while the orchestrator
// wires the same class from app.ts.
export { VerificationRunner, type VerificationRunnerDeps, type VerifyStoryInput, type VerifyStoryResult } from '../verify/runner.ts';
