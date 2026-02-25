# SSO Student App Example

A minimal Express.js app demonstrating how to use Hydra's `np_access` JWT cookie for authentication. Your app never touches SAML directly — it simply asks Hydra "is this user valid?" via the `/check` endpoint.

## Quick Start

```bash
cp .env.example .env   # edit if needed
npm install
node student-app.js
```

Open http://localhost:5175 in your browser.

## How It Works

1. User visits your app
2. Your app checks for the `np_access` cookie
3. If present, your app calls `POST https://hydra.newpaltz.edu/check` with the token as a Bearer header
4. Hydra returns user info (email, roles, groups) if the token is valid
5. If no token, show a "Login with New Paltz" button that redirects to Hydra's `/login`

## Deploying on Hydra

Deploy your app under `/students/{user}/{project}/`:

1. Place your project in `~/public_html/your-project/`
2. Your app will be accessible at `https://hydra.newpaltz.edu/students/{user}/your-project/`
3. The `np_access` cookie is shared across all `hydra.newpaltz.edu` subpaths — SSO just works

## Available Middleware

| Middleware | Description |
|-----------|-------------|
| `requireNP` | Requires valid `np_access` token with an allowed role |
| `requireFaculty` | Requires `faculty` role (chain after `requireNP`) |
| `requireStudent` | Requires `student` role (chain after `requireNP`) |
| `requireCompsci` | Requires `compsci-students` or `registered-students` group |

### Usage

```javascript
// Public route
router.get('/', (req, res) => { ... });

// Any authenticated user with allowed role
router.get('/dashboard', requireNP, (req, res) => {
  console.log(req.user.email);
});

// Faculty only
router.get('/grades', requireNP, requireFaculty, (req, res) => { ... });

// Students only
router.get('/assignments', requireNP, requireStudent, (req, res) => { ... });

// CS students only
router.get('/lab', requireNP, requireCompsci, (req, res) => { ... });
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HYDRA_BASE_URL` | `https://hydra.newpaltz.edu` | Hydra service URL |
| `APP_NAME` | `Student Demo` | Display name in the UI |
| `PORT` | `5175` | Server port |
| `ALLOWED_ROLES` | `student,faculty` | Comma-separated roles for `/restricted` |
| `APP_BASE_PATH` | (auto-detected) | Force a base path prefix |

## Routes

| Route | Auth | Description |
|-------|------|-------------|
| `/` | None | Home page with login/status |
| `/restricted` | `requireNP` | Gated page showing user info |
| `/faculty` | `requireNP` + `requireFaculty` | Faculty-only page |
| `/student` | `requireNP` + `requireStudent` | Student-only page |
| `/compsci` | `requireNP` + `requireCompsci` | CS students only |
| `/whoami` | None | JSON debug endpoint — shows `/check` response |

## Further Reading

See `np-access-auth-guide.md` for the full integration guide with examples in Node.js, Python, PHP, and Java.
