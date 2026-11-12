# ZELIMU CBC — single-branch Render deployment

This ZIP contains a single application source tree, **not multiple Git branches**. A ZIP cannot establish Git branch topology: create one GitHub repository and push its contents to **main** only.

1. Extract the ZIP and upload its contents to the repository root (not a nested folder).
2. In GitHub Codespaces: `git checkout -B main && git add . && git commit -m "ZELIMU CBC analytics and Render release" && git push -u origin main` (configure origin if this is a new repository).
3. In Render, connect that repository and select branch **main**. The included `render.yaml` is an optional Blueprint; alternatively configure Node, `npm ci`, and `npm start` manually.
4. Configure a persistent PostgreSQL `DATABASE_URL` and other required environment variables. Never commit `.env` secrets.
5. Run the project's required database migrations and bootstrap tasks according to its README before production use. Do not run destructive migrations against a live school database without a backup.
6. Test login, school isolation, marks, analytics, merit PDFs and timetable saves on a staging deployment before accepting live school data.

## Scope
New analytics display: top learners per learning area, gender by learning area, grade distribution by learning area. Existing merit ranking and report layouts were not modified. This does not certify all eight modules or third-party integrations.
