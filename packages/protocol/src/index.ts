export const PROTOCOL_VERSION = "v1" as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

export type HealthResponse = {
  status: "ok";
  instance_id: string;
  db_id: string;
  schema_version: number;
  protocol_version: ProtocolVersion;
  pid: number;
  uptime_seconds: number;
};
