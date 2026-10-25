# Hostinger / LiteSpeed deployment

## Startup file

Use:

```text
src/server.js
```

The server entry contains no top-level `await`, so Hostinger LiteSpeed's Node loader can synchronously load the ESM entry graph.

## Node.js

Use a current Node.js LTS/runtime supported by Hostinger. The project is ESM and keeps:

```json
"type": "module"
```

Do not convert the application to CommonJS just for Hostinger.

## Install command

From the server project root:

```bash
npm install --omit=dev
```

## Start command

If Hostinger asks for a start command, use:

```bash
npm start
```

If Hostinger asks for an application startup file, use:

```text
src/server.js
```

## Required environment variables

At minimum configure:

```env
NODE_ENV=production
MONGODB_URI=
JWT_SECRET=
CLIENT_URL=https://your-client-domain.example
ADMIN_URL=https://your-admin-domain.example
ADMIN_LOGIN_URL=https://your-admin-domain.example/login
```

Also configure the SMTP and bootstrap/admin variables your deployment uses.

Do not hardcode `PORT`. Hostinger supplies `process.env.PORT`; the server automatically uses it.

## CORS

`CLIENT_URL` and `ADMIN_URL` must exactly match the deployed origins, including `https://` and without unexpected alternate hostnames.

Example:

```env
CLIENT_URL=https://trli.onetrue.ph
ADMIN_URL=https://admin.trli.onetrue.ph
```

## Health check

After deployment open:

```text
https://YOUR_API_DOMAIN/api/health
```

Expected JSON:

```json
{
  "success": true,
  "message": "Trans Roadway API is healthy.",
  "data": {}
}
```

## Why the previous build failed

The old startup file used:

```js
await connectDB()
```

at module scope. Hostinger LiteSpeed loads the Node startup file through a synchronous `require()` bridge. Node can synchronously load an ESM graph only when that graph has no top-level await, so it raised `ERR_REQUIRE_ASYNC_MODULE`.

The fixed entry starts MongoDB through a promise chain instead, then starts HTTP and Socket.IO only after MongoDB connects.
