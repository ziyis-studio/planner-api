export interface WeatherLocation {
  name: string;
  latitude: number;
  longitude: number;
}
export const weatherLocations: Record<string, WeatherLocation> = {
  "Asia/Kuala_Lumpur": {
    name: "Kuala Lumpur",
    latitude: 3.139,
    longitude: 101.6869,
  },
  "Asia/Singapore": {
    name: "Singapore",
    latitude: 1.3521,
    longitude: 103.8198,
  },
  "Asia/Shanghai": { name: "Shanghai", latitude: 31.2304, longitude: 121.4737 },
  "Asia/Hong_Kong": {
    name: "Hong Kong",
    latitude: 22.3193,
    longitude: 114.1694,
  },
  "Asia/Tokyo": { name: "Tokyo", latitude: 35.6762, longitude: 139.6503 },
  "Asia/Seoul": { name: "Seoul", latitude: 37.5665, longitude: 126.978 },
  "Asia/Kolkata": { name: "Kolkata", latitude: 22.5726, longitude: 88.3639 },
  "Europe/London": { name: "London", latitude: 51.5074, longitude: -0.1278 },
  "Europe/Paris": { name: "Paris", latitude: 48.8566, longitude: 2.3522 },
  "America/New_York": {
    name: "New York",
    latitude: 40.7128,
    longitude: -74.006,
  },
  "America/Los_Angeles": {
    name: "Los Angeles",
    latitude: 34.0522,
    longitude: -118.2437,
  },
  "Australia/Sydney": {
    name: "Sydney",
    latitude: -33.8688,
    longitude: 151.2093,
  },
};

const cache = new Map<string, { at: number; value: unknown }>();
export async function currentWeather(zone: string) {
  const location = weatherLocations[zone];
  if (!location) throw new Error("No weather for this time zone.");
  const existing = cache.get(zone);
  if (existing && Date.now() - existing.at < 300000) return existing.value;
  const query = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    current: "temperature_2m,weather_code",
    timezone: zone,
  });
  const response = await fetch(
    "https://api.open-meteo.com/v1/forecast?" + query,
    { signal: AbortSignal.timeout(10000) },
  );
  if (!response.ok) throw new Error("Weather unavailable.");
  const result = await response.json();
  if (
    !Number.isFinite(result.current?.temperature_2m) ||
    !Number.isFinite(result.current?.weather_code)
  )
    throw new Error("Weather unavailable.");
  const value = {
    temperature: result.current.temperature_2m,
    code: result.current.weather_code,
    updatedAt: result.current.time,
  };
  cache.set(zone, { at: Date.now(), value });
  return value;
}
