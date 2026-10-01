//! Wall-clock helpers in the machine's own time zone.
//!
//! Providers and models name times the way a person reads a clock ("resets
//! 12:20am", "reset at 00:40"), so turning one into an instant needs the local
//! offset. The C library already knows it; nothing else here needs a time-zone
//! database.

/// Milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn local_parts(at_ms: i64) -> Option<libc::tm> {
    let seconds = (at_ms.div_euclid(1000)) as libc::time_t;
    // SAFETY: `localtime_r` writes only into the `tm` it is given.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let result = unsafe { libc::localtime_r(&seconds, &mut tm) };
    if result.is_null() { None } else { Some(tm) }
}

/// The next instant after `now_ms` at which the local clock reads
/// `hour:minute` — today if that is still ahead, else tomorrow.
pub fn next_local_time(now_ms: i64, hour: u32, minute: u32) -> i64 {
    #[cfg(unix)]
    {
        if let Some(mut tm) = local_parts(now_ms) {
            tm.tm_hour = hour as libc::c_int;
            tm.tm_min = minute as libc::c_int;
            tm.tm_sec = 0;
            tm.tm_isdst = -1;
            // SAFETY: `mktime` normalises the struct it is given.
            let seconds = unsafe { libc::mktime(&mut tm) };
            if seconds != -1 {
                let mut at = seconds as i64 * 1000;
                if at <= now_ms {
                    at += 24 * 60 * 60_000;
                }
                return at;
            }
        }
    }
    // Without a local clock, read the time as UTC: wrong by a zone at worst,
    // which costs one early retry.
    let day = 24 * 60 * 60_000;
    let midnight = now_ms - now_ms.rem_euclid(day);
    let mut at = midnight + (hour as i64 * 60 + minute as i64) * 60_000;
    if at <= now_ms {
        at += day;
    }
    at
}

/// `HH:MM` in local time, for messages.
pub fn local_hhmm(at_ms: i64) -> String {
    #[cfg(unix)]
    {
        if let Some(tm) = local_parts(at_ms) {
            return format!("{:02}:{:02}", tm.tm_hour, tm.tm_min);
        }
    }
    let minutes = at_ms.div_euclid(60_000).rem_euclid(24 * 60);
    format!("{:02}:{:02}", minutes / 60, minutes % 60)
}

/// An instant as ISO 8601 in UTC, the way the journal has always written it.
pub fn iso8601(at_ms: i64) -> String {
    let seconds = at_ms.div_euclid(1000);
    let millis = at_ms.rem_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Howard Hinnant's days-to-civil conversion.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_next_time_on_the_clock_is_ahead_and_within_a_day() {
        let now = now_ms();
        for (hour, minute) in [(0, 0), (12, 30), (23, 59)] {
            let at = next_local_time(now, hour, minute);
            assert!(at > now && at <= now + 24 * 60 * 60_000 + 60 * 60_000, "{hour}:{minute}");
            assert_eq!(local_hhmm(at), format!("{hour:02}:{minute:02}"));
        }
    }

    #[test]
    fn iso_dates_are_utc() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_700_000_000_123), "2023-11-14T22:13:20.123Z");
    }
}
