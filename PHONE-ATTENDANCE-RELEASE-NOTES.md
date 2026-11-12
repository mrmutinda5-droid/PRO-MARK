# Phone-first attendance update

Implemented in `public/dashboard.html` inside the existing Attendance module:
- Camera barcode/QR scanning via browser `BarcodeDetector` and `getUserMedia` when supported.
- Manual admission-number lookup for unsupported browsers, with exact selected-class matching.
- Matched learner marked PRESENT in the on-screen register; existing SAVE ATTENDANCE persists it through the existing tenant-scoped attendance API.
- Camera stop control and track cleanup; no raw biometric capture.

## Limitations and deployment notes
- QR scanning requires a camera-capable browser with BarcodeDetector support and a secure HTTPS origin; fallback is manual admission lookup.
- School-issued QR/ID generation is NOT implemented by this update. Existing cards bearing admission-number QR or barcodes may be scanned.
- This is NOT fingerprint identification. Fingerprint/face matching for multiple students needs compatible devices/vendor APIs and privacy compliance.
- A scan does not save attendance automatically; users must press SAVE ATTENDANCE.
- No live PostgreSQL, camera hardware, or production multi-role integration testing was performed in this environment.
- Transport, Boarding, HR, payment providers, and SMS delivery are not certified fully functional.
