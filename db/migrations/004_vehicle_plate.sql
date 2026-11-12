-- Vehicle numberplates
--
-- Operators identify vehicles by registration plate, not by internal id or
-- a free-text label, so the plate becomes the primary on-screen identifier
-- (map tags, fleet list, alerts, compliance). Nullable so existing customer
-- vehicles keep working; the Fleet tab prompts to fill in any missing plate.
-- Stored upper-case with single spaces (normalised in server.js).

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS plate TEXT;

-- One vehicle per plate within an organisation (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vehicles_org_plate
  ON vehicles (org_id, upper(plate))
  WHERE plate IS NOT NULL;

-- Demonstration fleet plates (Victorian format). Only fills blanks, so it
-- never overwrites a plate someone has since edited.
UPDATE vehicles SET plate = v.plate
FROM (VALUES
  ('VIC-01', '1TK 4RD'),
  ('VIC-02', '1TK 4RE'),
  ('VIC-03', 'XWC 203'),
  ('VIC-04', 'XWC 204'),
  ('VIC-05', '2PU 5KL'),
  ('VIC-06', '2PU 6KM'),
  ('VIC-07', 'EV 07DV'),
  ('VIC-08', 'EV 08DV'),
  ('VIC-09', '1MN 9OB'),
  ('VIC-10', '1MN 0NP')
) AS v(id, plate)
WHERE vehicles.id = v.id AND vehicles.plate IS NULL;
