// Sensor hardware models supported by the registry
export type Co2SensorModel = "MH-Z19C";
export type LpgSensorModel = "MQ-6";

export type SeverityLevel = "normal" | "elevated" | "danger";

export type DeviceConnectionStatus = "online" | "offline";

export interface RoomDimensions {
  lengthM: number;
  widthM: number;
  heightM: number;
}

export interface DeviceReadings {
  co2Ppm: number | null; // null when no CO2 sensor is installed
  lpgPpm: number | null; // null when no LPG sensor is installed
  temperatureC: number;
  humidityPct: number;
}

export interface IoTDevice {
  id: string; // e.g. "AIR-106"
  roomName: string; // e.g. "Room 106"
  floor: string; // e.g. "Ground Floor"
  hasCo2Sensor: boolean;
  hasLpgSensor: boolean;
  co2SensorModel?: Co2SensorModel;
  lpgSensorModel?: LpgSensorModel;
  dimensions: RoomDimensions;
  occupants: number;
  readings: DeviceReadings;
  connectionStatus: DeviceConnectionStatus;
  lastUpdated: string; // ISO timestamp
}

export interface SensorSpec {
  model: Co2SensorModel | LpgSensorModel;
  displayName: string;
  description: string;
  gasesMonitored: string;
  sensingRange: string;
  accuracyRating: string;
  keySpecs: string[];
}

export type UserRole = "admin" | "maintenance" | "security";

export interface DemoAccount {
  role: UserRole;
  label: string;
  email: string;
  accessLevel: string;
}
