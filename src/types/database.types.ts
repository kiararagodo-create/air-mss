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