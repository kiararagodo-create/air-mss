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

// ---------------------------------------------------------------------------
// New tables – added by migrations 20260917*
// ---------------------------------------------------------------------------

export interface Database {
  public: {
    Tables: {
      readings: {
        Row: {
          id: number;
          device_id: string;
          co2: number | null;
          lpg: number | null;
          temp: number | null;
          humidity: number | null;
          severity: number;
          status: "normal" | "warning" | "high" | "danger";
          created_at: string;
        };
        Insert: {
          id?: number;
          device_id: string;
          co2?: number | null;
          lpg?: number | null;
          temp?: number | null;
          humidity?: number | null;
          severity?: number;
          status?: "normal" | "warning" | "high" | "danger";
          created_at?: string;
        };
        Update: {
          id?: number;
          device_id?: string;
          co2?: number | null;
          lpg?: number | null;
          temp?: number | null;
          humidity?: number | null;
          severity?: number;
          status?: "normal" | "warning" | "high" | "danger";
          created_at?: string;
        };
      };
      rooms: {
        Row: {
          id: string;
          name: string;
          floor: string;
          type: string | null;
          active: boolean;
          co2: number | null;
          lpg: number | null;
          alert_count: number | null;
          last_seen: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          name: string;
          floor: string;
          type: string | null;
          active: boolean;
          co2: number | null;
          lpg: number | null;
          alert_count?: number | null;
          last_seen?: string | null;
          created_at?: string;
        };
        Update: {
          id?: string;
          name?: string;
          floor?: string;
          type?: string | null;
          active?: boolean;
          co2?: number | null;
          lpg?: number | null;
          alert_count?: number | null;
          last_seen?: string | null;
          created_at?: string;
        };
      };
      devices: {
        Row: {
          device_id: string;
          room_id: string;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          device_id: string;
          room_id: string;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          device_id?: string;
          room_id?: string;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      room_thresholds: {
        Row: {
          id: number;
          room_id: string;
          co2_warning: number | null;
          co2_high: number | null;
          co2_danger: number | null;
          lpg_warning: number | null;
          lpg_high: number | null;
          lpg_danger: number | null;
          temp_freeze_below: number | null;
          temp_cool_below: number | null;
          temp_heat_above: number | null;
          humidity_dry_below: number | null;
          humidity_low_below: number | null;
          humidity_mold_above: number | null;
          active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: number;
          room_id: string;
          co2_warning?: number | null;
          co2_high?: number | null;
          co2_danger?: number | null;
          lpg_warning?: number | null;
          lpg_high?: number | null;
          lpg_danger?: number | null;
          temp_freeze_below?: number | null;
          temp_cool_below?: number | null;
          temp_heat_above?: number | null;
          humidity_dry_below?: number | null;
          humidity_low_below?: number | null;
          humidity_mold_above?: number | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: number;
          room_id?: string;
          co2_warning?: number | null;
          co2_high?: number | null;
          co2_danger?: number | null;
          lpg_warning?: number | null;
          lpg_high?: number | null;
          lpg_danger?: number | null;
          temp_freeze_below?: number | null;
          temp_cool_below?: number | null;
          temp_heat_above?: number | null;
          humidity_dry_below?: number | null;
          humidity_low_below?: number | null;
          humidity_mold_above?: number | null;
          active?: boolean;
          created_at?: string;
          updated_at?: string;
        };
      };
      alert_recipients: {
        Row: {
          id: number;
          name: string;
          phone_number: string;
          role: "admin" | "maintenance" | "security";
          active: boolean;
          room_ids: string[] | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          name: string;
          phone_number: string;
          role?: "admin" | "maintenance" | "security";
          active?: boolean;
          room_ids?: string[] | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          name?: string;
          phone_number?: string;
          role?: "admin" | "maintenance" | "security";
          active?: boolean;
          room_ids?: string[] | null;
          created_at?: string;
          updated_at?: string;
        };
      };
      alert_log: {
        Row: {
          id: number;
          device_id: string;
          room_id: string;
          room_name: string;
          sensor: string;
          level: "Elevated Gas" | "Danger" | "Critical";
          created_at: string;
          sms_status: "pending" | "sent" | "failed";
          sms_response: string | null;
        };
        Insert: {
          id?: number;
          device_id: string;
          room_id: string;
          room_name: string;
          sensor: string;
          level: "Elevated Gas" | "Danger" | "Critical";
          created_at?: string;
          sms_status?: "pending" | "sent" | "failed";
          sms_response?: string | null;
        };
        Update: {
          id?: number;
          device_id?: string;
          room_id?: string;
          room_name?: string;
          sensor?: string;
          level?: "Elevated Gas" | "Danger" | "Critical";
          sms_status?: "pending" | "sent" | "failed";
          sms_response?: string | null;
        };
      };
    };
    Views: {};
    Functions: {
      report_thresholds: {
        Args: { p_thresholds: JSON };
        Returns: JSON;
      };
      resolve_thresholds: {
        Args: { p_at: string | null };
        Returns: JSON;
      };
      is_active_admin: {
        Args: {};
        Returns: boolean;
      };
      is_approved_account: {
        Args: {};
        Returns: boolean;
      };
    };
    Types: {};
  };
}