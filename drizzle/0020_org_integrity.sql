-- C3b review #2 and #5 (additive): the database itself keeps org rows inside their chart and
-- company, and a department number is used by at most one live department of a chart.
-- No table is added (so no new RLS statement); nothing is dropped.
--
-- 1. Unique (id, company_id) / (id, chart_id) pairs: targets of the composite foreign keys.
ALTER TABLE "org_charts" ADD CONSTRAINT "org_charts_id_company_uq" UNIQUE("id","company_id");--> statement-breakpoint
ALTER TABLE "org_divisions" ADD CONSTRAINT "org_divisions_id_chart_uq" UNIQUE("id","chart_id");--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_id_chart_uq" UNIQUE("id","chart_id");--> statement-breakpoint
-- 2. Duplicate live department numbers (possible before this fix): the first one (by sort,
-- then creation) keeps its number, every other one gets the smallest free number from 22 up
-- (archived departments keep theirs). Logged in the chart's history. Normally nothing to do.
DO $$
DECLARE
  d record;
  free_number integer;
BEGIN
  FOR d IN
    SELECT x.id, x.chart_id, x.company_id, x.number, x.name
    FROM (
      SELECT o.*, row_number() OVER (PARTITION BY o.chart_id, o.number ORDER BY o.sort, o.created_at, o.id) AS rn
      FROM "org_departments" o
      WHERE o.archived_at IS NULL
    ) x
    WHERE x.rn > 1
  LOOP
    SELECT n INTO free_number
    FROM generate_series(22, 99) AS n
    WHERE NOT EXISTS (
      SELECT 1 FROM "org_departments" o2 WHERE o2.chart_id = d.chart_id AND o2.number = n AND o2.archived_at IS NULL
    )
    ORDER BY n
    LIMIT 1;
    IF free_number IS NULL THEN
      RAISE EXCEPTION 'org chart % has no free department number left for %', d.chart_id, d.id;
    END IF;
    UPDATE "org_departments" SET "number" = free_number, "updated_at" = now() WHERE "id" = d.id;
    INSERT INTO "org_change_log" ("chart_id", "company_id", "entity", "entity_id", "action", "before", "after", "summary")
    VALUES (d.chart_id, d.company_id, 'department', d.id, 'renumber', jsonb_build_object('number', d.number), jsonb_build_object('number', free_number),
            'Renumbered duplicate department ' || d.number || ' ' || d.name || ' to ' || free_number);
  END LOOP;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX "org_departments_live_number_uq" ON "org_departments" USING btree ("chart_id","number") WHERE "org_departments"."archived_at" is null;--> statement-breakpoint
-- 3. Composite foreign keys: a division / department / function / log row has its chart's
-- company, a department its division's chart, a function its department's chart.
ALTER TABLE "org_divisions" ADD CONSTRAINT "org_divisions_chart_company_fk" FOREIGN KEY ("chart_id","company_id") REFERENCES "public"."org_charts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_chart_company_fk" FOREIGN KEY ("chart_id","company_id") REFERENCES "public"."org_charts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_departments" ADD CONSTRAINT "org_departments_division_chart_fk" FOREIGN KEY ("division_id","chart_id") REFERENCES "public"."org_divisions"("id","chart_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_functions" ADD CONSTRAINT "org_functions_chart_company_fk" FOREIGN KEY ("chart_id","company_id") REFERENCES "public"."org_charts"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_functions" ADD CONSTRAINT "org_functions_department_chart_fk" FOREIGN KEY ("department_id","chart_id") REFERENCES "public"."org_departments"("id","chart_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_change_log" ADD CONSTRAINT "org_change_log_chart_company_fk" FOREIGN KEY ("chart_id","company_id") REFERENCES "public"."org_charts"("id","company_id") ON DELETE no action ON UPDATE no action;
