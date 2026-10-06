// fetch, for the desk's own buttons: a dropped connection or a stopped server
// comes back as an error response the caller already handles, instead of a
// rejected promise that leaves the button stuck on "working".
export async function request(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : "the request failed";
    return new Response(JSON.stringify({ error: `could not reach the desk: ${message}` }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}
