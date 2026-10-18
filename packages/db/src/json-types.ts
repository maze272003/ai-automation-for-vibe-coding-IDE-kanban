export interface ChecksSummary { total: number; passed: number; failed: number; pending: number; conclusion: 'success' | 'failure' | 'pending' | 'none' }
export interface ReviewsSummary { approved: number; changesRequested: number; commented: number }
export interface QuotaState { exhaustedUntil: number | null; lastStatus: number | null; remaining: number | null }
export interface ProbeResult { toolCall: boolean; longContext: boolean; jsonSchema: boolean; ttftMs: number | null; genTokensPerSec: number | null; testedAt: number }
export interface StoryEventPayload { [key: string]: unknown }
export interface OutboxPayload { provenance: string; data: unknown }
