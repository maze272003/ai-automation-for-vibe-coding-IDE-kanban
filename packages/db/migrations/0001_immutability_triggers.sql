CREATE TRIGGER `story_events_no_update` BEFORE UPDATE ON `story_events` BEGIN SELECT RAISE(ABORT, 'story_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `story_events_no_delete` BEFORE DELETE ON `story_events` BEGIN SELECT RAISE(ABORT, 'story_events is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `reviews_no_update` BEFORE UPDATE ON `reviews` BEGIN SELECT RAISE(ABORT, 'reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `reviews_no_delete` BEFORE DELETE ON `reviews` BEGIN SELECT RAISE(ABORT, 'reviews is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_findings_no_update` BEFORE UPDATE ON `review_findings` BEGIN SELECT RAISE(ABORT, 'review_findings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_findings_no_delete` BEFORE DELETE ON `review_findings` BEGIN SELECT RAISE(ABORT, 'review_findings is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_ac_results_no_update` BEFORE UPDATE ON `review_ac_results` BEGIN SELECT RAISE(ABORT, 'review_ac_results is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `review_ac_results_no_delete` BEFORE DELETE ON `review_ac_results` BEGIN SELECT RAISE(ABORT, 'review_ac_results is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `verification_checks_no_update` BEFORE UPDATE ON `verification_checks` BEGIN SELECT RAISE(ABORT, 'verification_checks is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `verification_checks_no_delete` BEFORE DELETE ON `verification_checks` BEGIN SELECT RAISE(ABORT, 'verification_checks is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `merge_approvals_no_update` BEFORE UPDATE ON `merge_approvals` BEGIN SELECT RAISE(ABORT, 'merge_approvals is append-only'); END;
--> statement-breakpoint
CREATE TRIGGER `merge_approvals_no_delete` BEFORE DELETE ON `merge_approvals` BEGIN SELECT RAISE(ABORT, 'merge_approvals is append-only'); END;
