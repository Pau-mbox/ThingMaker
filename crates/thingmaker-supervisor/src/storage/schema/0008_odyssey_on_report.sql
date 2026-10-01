-- What the runner does when the agent reports a milestone done but nothing has
-- checked it (docs/plans/odyssey.md §5.4).
--
-- Until now a claim always stopped the run and waited for a tick. For a plan
-- whose checks are all `manual` — which is most plans, because the planner
-- refuses to invent commands — that is a stop at every milestone, and a
-- long-horizon runner that halts twelve times is not one.
--
-- 'continue' does NOT make the milestone verified. It stays `reported`, the
-- badge still says unverified and the verified count still only counts real
-- evidence; the run simply moves to the next milestone instead of parking.
ALTER TABLE odysseys ADD COLUMN on_report TEXT NOT NULL DEFAULT 'continue'
  CHECK (on_report IN ('wait', 'continue'));
