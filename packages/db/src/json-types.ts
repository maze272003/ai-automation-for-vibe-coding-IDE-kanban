export interface ChecksSummary {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  conclusion: 'success' | 'failure' | 'pending' | 'none';
  checks?: Array<{ name: string; status: string; conclusion: string | null; url?: string | null }>;
}
export interface ReviewsSummary {
  approved: number;
  changesRequested: number;
  commented: number;
  state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'NONE';
  reviews?: Array<{ user: string; state: string; body?: string; submittedAt?: string }>;
}
export interface QuotaState { exhaustedUntil: number | null; lastStatus: number | null; remaining: number | null }
export interface ProbeResult { toolCall: boolean; longContext: boolean; jsonSchema: boolean; ttftMs: number | null; genTokensPerSec: number | null; testedAt: number }
export interface StoryEventPayload { [key: string]: unknown }
export interface OutboxPayload { provenance: string; data: unknown }
