import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const HOOK_SECRET = Deno.env.get("SEND_EMAIL_HOOK_SECRET")!;

Deno.serve(async (req) => {
  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);
  const wh = new Webhook(HOOK_SECRET);

  let data;
  try {
    data = wh.verify(payload, headers);
  } catch (err) {
    return new Response("Invalid signature", { status: 401 });
  }

  const { user, email_data } = data as {
    user: { email: string };
    email_data: {
      token: string;
      token_hash: string;
      redirect_to: string;
      email_action_type: string;
    };
  };

  if (email_data.email_action_type !== "recovery") {
    return new Response(JSON.stringify({}), { status: 200 });
  }

  const html = `
    <h2>Reset your password</h2>
    <p>We received a request to reset your password for A.I.R.</p>
    <p>Your verification code is:</p>
    <h1 style="letter-spacing: 4px;">${email_data.token}</h1>
    <p>This code will expire shortly. If you didn't request this, you can safely ignore this email.</p>
  `;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "A.I.R. <onboarding@resend.dev>",
      to: [user.email],
      subject: "Reset your password",
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    return new Response(JSON.stringify({ error: err }), { status: 500 });
  }

  return new Response(JSON.stringify({}), { status: 200 });
});
