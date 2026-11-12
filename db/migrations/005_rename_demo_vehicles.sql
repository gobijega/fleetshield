-- Rename the two demonstration vehicles previously labelled "Council Truck
-- 01/02" to "Service Truck 01/02" (founder decision, Nov 2026: no council
-- references in Fleet Shield copy or demo data). Updates the vehicle rows
-- and the label/message text of their past alerts, so the dashboard,
-- Alerts and Reports read consistently. Only touches the demo vehicles in
-- the 'default' organisation, and only while they still carry the old
-- label, so it is safe to re-run and never renames a customer's vehicle.
-- The audit log is deliberately left unchanged: it is a historical record.

UPDATE vehicles
   SET label = replace(label, 'Council Truck', 'Service Truck')
 WHERE org_id = 'default'
   AND id IN ('VIC-01', 'VIC-02')
   AND label LIKE 'Council Truck%';

UPDATE alerts
   SET vehicle_label = replace(vehicle_label, 'Council Truck', 'Service Truck'),
       message = replace(message, 'Council Truck', 'Service Truck')
 WHERE org_id = 'default'
   AND vehicle_id IN ('VIC-01', 'VIC-02')
   AND (vehicle_label LIKE 'Council Truck%' OR message LIKE '%Council Truck%');
