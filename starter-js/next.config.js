/** @type {import('next').NextConfig} */
const nextConfig = {
  // No `serverActions.bodySizeLimit`: Server Actions keep Next's 1 MB default.
  // A dropped file goes from the browser straight to Pipelex storage with an
  // upload grant (src/hooks/useFileInputs.ts), so a grant action only receives
  // a file's name, type and size, and a run only references. What can still
  // reach the limit is a run's text and other typed values, so `useRun`
  // measures them first and refuses a set past `MAX_RUN_INPUT_BYTES`
  // (src/lib/runRequest.ts) with the size and the limit, rather than let Next
  // refuse the body where the browser would only see an unreachable server.
  // Raise both together; a test holds them to each other.
  // The floating badge `next dev` draws on every page. The app is what its
  // developer shows people, and the badge is chrome of Next's, not of the app.
  // Next still surfaces compile and runtime errors with it off.
  devIndicators: false,
  // `next dev` logs every Server Function call with its arguments, which are
  // whatever a user typed into the form — an extraction's text, an image
  // prompt — and, before files went straight to storage, every document a user
  // dropped, printed whole as base64. Only the object form turns that one log
  // off: `logging: false` would silence the fetch logs too.
  logging: {
    serverFunctions: false,
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
