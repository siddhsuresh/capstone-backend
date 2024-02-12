//@ts-check
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import cors from "cors";
import { createClient } from "@libsql/client";
import {
  AuthServerPlugin,
  getSession,
  simpleRolesIsAuthorized,
} from "@blitzjs/auth";
import Stripe from "stripe";

const stripe = new Stripe(String(process.env.STRIPE_SECRET_KEY));
const turso = createClient({
  url: String(process.env.TURSO_DB_URL),
  authToken: process.env.TURSO_DB_AUTH_TOKEN,
});

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "http://localhost:5173",
    credentials: true,
  },
});

const blitzServerAuth = AuthServerPlugin({
  cookiePrefix: "capstone",
  isAuthorized: simpleRolesIsAuthorized,
  sameSite: "none",
  secureCookies: true,
  storage: {
    getSession: async (handle) => {
      const { rows } = await turso.execute(
        `SELECT * FROM Session WHERE handle = '${handle}'`
      );
      const session = rows[0];
      return {
        ...session,
        expiresAt: new Date(
          String(session?.expiresAt ?? new Date().toISOString())
        ),
        privateData: String(
          session?.privateData ? session?.privateData : JSON.stringify({})
        ),
        publicData: String(
          session?.publicData ? session?.publicData : JSON.stringify({})
        ),
        handle,
      };
    },
    createSession: async (session) => {
      const { rows } = await turso.execute(
        `INSERT INTO Session (handle, expiresAt,antiCSRFToken,hashedSessionToken,userId) VALUES ('${session.handle}', '${session.expiresAt}', '${session.antiCSRFToken}', '${session.hashedSessionToken}', '${session.userId}') RETURNING *`
      );
      return {
        ...rows[0],
        handle: session.handle,
      };
    },
    updateSession: async (handle, data) => {
      const { rows } = await turso.execute(
        `UPDATE Session SET data = '${data}' WHERE handle = '${handle}' RETURNING *`
      );
      return {
        ...rows[0],
        handle,
      };
    },
    deleteSession: async (handle) => {
      const { rows } = await turso.execute(
        `DELETE FROM Session WHERE handle = '${handle}' RETURNING *`
      );
      return {
        ...rows[0],
        handle,
      };
    },
    getSessions: async (userId) => {
      const { rows } = await turso.execute(
        `SELECT * FROM Session WHERE data->>'userId' = '${userId}'`
      );
      return rows.map((row) => ({
        ...row,
        handle: String(row.handle),
      }));
    },
  },
});

app.use(express.json());
app.set("trust proxy", 1);
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);
app.use(async (req, res, next) => {
  //@ts-expect-error
  await blitzServerAuth.requestMiddlewares[0](req, res, next);
});

app.get("/", async (req, res) => {
  const session = await getSession(req, res);
  res.send("OK");
});

app.get("/temp", async (req, res) => {
  const { rows } = await turso.execute("SELECT * FROM temperature");
  return res.json(rows);
});

app.get("/create_session", async (req, res) => {
  const userId = req.body.userId;
  // @ts-expect-error
  await res.blitzCtx.session.$create({ userId, role: "user" });
  res.send("OK");
});

app.get("/clear_session", (req, res) => {
  res.send("OK");
});

app.get("/stripe", async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "T-shirt",
          },
          unit_amount: Number(req.query.amount),
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: "http://localhost:8080/stripe/success",
    cancel_url: "http://localhost:8080/stripe/cancel",
  });
  res.json({ id: session.id });
});

app.get("/stripe/success", (req, res) => {
  //@ts-expect-error
  res.blitzCtx.session.$create({ userId: "payed", role: "user" });
  res.send("success");
})

app.get("/stripe/cancel", (req, res) => {
  res.send("cancel");
})

io.on("connection", (socket) => {
  socket.on("connect", () => {
    console.log("connected");
  });
  socket.on("disconnect", () => {
    console.log("disconnected");
  });
  socket.on("dht", async (data) => {
    io.emit("esp8266", true);
    if (data >= 32) {
      io.emit("alert", "HIGH");
    }
    await turso.execute(
      `INSERT INTO temperature (reading) VALUES (${data}) RETURNING *`
    );
    io.emit("temp", data);
  });
  socket.on("alert", (data) => {
    io.emit("alert", data);
  });
});

server.listen(8080, () => {
  console.log("server running at http://localhost:8080");
});
