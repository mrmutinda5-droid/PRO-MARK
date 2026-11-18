# ZELIMU CBC — Analytics, brand and timetable improvements

- Replaced the generic shield with an original book-and-growth logo (not copied from Zeraki, Zamifu or Ladybird).
- Added a downloadable academic analytics CSV export using the existing authenticated school analytics response.
- Exports subject, class, term and proficiency data when present; filters obvious secret/contact fields.
- Updated the Academic menu label to accurately reflect the automatic timetable generator.
- Timetable generation now respects per-assignment weekly lesson counts if those fields exist, otherwise uses the configured default.

## Limitations
This is a source-code update. Live PostgreSQL, user-role, browser and scheduling load tests have not been completed in this environment. The generator is not ASC Timetables feature-complete; M-Pesa, SMS, GPS and biometric hardware integrations are not certified.
