export interface IoTDevice {
  id: string;
  name: string;
  floor: string;
  co2Sensor: string;
  gasSensor: string | null;
  length: number;
  width: number;
  height: number;
  occupancy: number;
  co2: number;
  lpg: number | null;
  temp: number;
  humidity: number;
  connectionStatus: "online" | "offline";
  alertCount: number;
}

// Hand-written to match the actual Supabase schema (checked via
// information_schema.columns). Generate this with the Supabase CLI instead
// once dashboard access to the project is sorted out:
//   npx supabase gen types typescript --project-id <id> --schema public
export interface Database {
  public: {
    Tables: {
      readings: {
        Row: {
          id: number;
          device_id: string;
          co2: number | null;
          lpg: number | null;
          severity: number;
          created_at: string;
        };
        Insert: {
          id?: number;
          device_id: string;
          co2?: number | null;
          lpg?: number | null;
          severity?: number;
          created_at?: string;
        };
        Update: {
          id?: number;
          device_id?: string;
          co2?: number | null;
          lpg?: number | null;
          severity?: number;
          created_at?: string;
        };
      };
      rooms: {
        Row: {
          id: string;
          name: string;
          floor: string;
          sensor: string;
          length: number;
          width: number;
          height: number;
          occupancy: number;
          co2: number | null;
          lpg: number | null;
          alert_count: number;
          last_seen: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          name: string;
          floor: string;
          sensor: string;
          length: number;
          width: number;
          height: number;
          occupancy: number;
          co2?: number | null;
          lpg?: number | null;
          alert_count?: number;
          last_seen?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          floor?: string;
          sensor?: string;
          length?: number;
          width?: number;
          height?: number;
          occupancy?: number;
          co2?: number | null;
          lpg?: number | null;
          alert_count?: number;
          last_seen?: string | null;
          created_at?: string;
        };
      };
    };
  };
}