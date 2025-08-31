import { DateTime } from "luxon";

const ALADHAN = "https://api.aladhan.com/v1";

function fold(line) {
  if (line.length <= 73) return line;
  let out = "";
  while (line.length > 73) {
    out += line.slice(0, 73) + "\r\n ";
    line = line.slice(73);
  }
  return out + line;
}

function ev({ tz, uid, start, title, alarmMinutes, location, desc }) {
  const fmt = (dt) => dt.toFormat("yyyyLLdd'T'HHmmss");
  const lines = [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${DateTime.utc().toFormat("yyyyLLdd'T'HHmmss'Z'")}`,
    `DTSTART;TZID=${tz}:${fmt(start)}`,
    `DTEND;TZID=${tz}:${fmt(start)}`,
    `SUMMARY:${title}`,
    location ? `LOCATION:${location}` : null,
    desc ? fold(`DESCRIPTION:${desc}`) : null,
    alarmMinutes
      ? [
          "BEGIN:VALARM",
          `TRIGGER:-PT${alarmMinutes}M`,
          "ACTION:DISPLAY",
          `DESCRIPTION:${title} dans ${alarmMinutes} min`,
          "END:VALARM",
        ].join("\r\n")
      : null,
    "END:VEVENT",
  ].filter(Boolean);
  return lines.join("\r\n");
}

function icsHeader({ name, tz }) {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Prayer ICS//aladhan.com//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    fold(`NAME:${name}`),
    fold(`X-WR-CALNAME:${name}`),
    `X-WR-TIMEZONE:${tz}`,
  ].join("\r\n");
}

export default async function handler(req, res) {
  const {
    lat,
    lon,
    city = "",
    country = "",
    method = "12",
    school = "0",
    latitudeAdjustmentMethod = "3",
    tune = "",
    alarm = "",
    horizon = "365"
  } = req.query;

  const latHdr = req.headers["x-vercel-ip-latitude"];
  const lonHdr = req.headers["x-vercel-ip-longitude"];
  const LAT = parseFloat(lat ?? latHdr ?? "48.8566");
  const LON = parseFloat(lon ?? lonHdr ?? "2.3522");

  const now = DateTime.local();
  const until = now.plus({ days: Math.min(parseInt(horizon) || 365, 400) });

  const months = [];
  let cursor = DateTime.local(now.year, now.month, 1);
  while (cursor <= until) {
    months.push({ y: cursor.year, m: cursor.month });
    cursor = cursor.plus({ months: 1 });
  }

  let tz = "Europe/Paris";
  let events = [];
  const alarmMinutes = alarm ? Math.max(parseInt(alarm), 0) : 0;
  const locLabel = [city, country].filter(Boolean).join(", ");

  for (const { y, m } of months) {
    const url = new URL(`${ALADHAN}/calendar`);
    url.searchParams.set("latitude", LAT.toFixed(6));
    url.searchParams.set("longitude", LON.toFixed(6));
    url.searchParams.set("method", method);
    url.searchParams.set("school", school);
    url.searchParams.set("latitudeAdjustmentMethod", latitudeAdjustmentMethod);
    url.searchParams.set("month", m);
    url.searchParams.set("year", y);
    url.searchParams.set("iso8601", "true");
    if (tune) url.searchParams.set("tune", tune);

    const r = await fetch(url.toString(), { headers: { "user-agent": "prayer-ics" }});
    if (!r.ok) continue;
    const js = await r.json();
    if (!js?.data?.length) continue;

    if (js?.data?.[0]?.meta?.timezone) tz = js.data[0].meta.timezone;

    for (const d of js.data) {
      const iso = d?.date?.gregorian?.date;
      if (!iso) continue;
      const base = DateTime.fromISO(iso, { zone: tz });
      const times = d?.timings || {};
      const t = (s) => (s || "").split(" ")[0];

      const prayers = [
        ["Fajr", t(times.Fajr)],
        ["Dhuhr", t(times.Dhuhr)],
        ["Asr", t(times.Asr)],
        ["Maghrib", t(times.Maghrib)],
        ["Isha", t(times.Isha)],
      ];

      for (const [name, hhmm] of prayers) {
        const [hh, mm] = (hhmm || "").split(":").map(Number);
        if (Number.isFinite(hh) && Number.isFinite(mm)) {
          const dt = base.set({ hour: hh, minute: mm, second: 0 });
          const uid = `${name}-${dt.toMillis()}-${LAT.toFixed(2)}-${LON.toFixed(2)}@prayer-ics`;
          events.push(
            ev({
              tz,
              uid,
              start: dt,
              title: name,
              alarmMinutes: alarmMinutes || null,
              location: locLabel,
              desc: `Calcul: AlAdhan (method=${method}, school=${school}).`
            })
          );
        }
      }
    }
  }

  const name = `Horaires de prière – ${locLabel || `${LAT.toFixed(3)},${LON.toFixed(3)}`}`;
  const body = [
    icsHeader({ name, tz }),
    ...events,
    "END:VCALENDAR"
  ].join("\r\n");

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
  res.status(200).send(body);
}
