-- Phase C (cloud-direct COROS): the desktop bridge era is over. The worker
-- talks to COROS directly; nothing reads these tables any more (code removed
-- and deployed before this migration runs).
DROP TABLE `device_handshakes`;
--> statement-breakpoint
DROP TABLE `desktop_devices`;
