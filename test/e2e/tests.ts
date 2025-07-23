import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts";
import {
  createClient,
  tealbaseClient,
} from "npm:@tealbase/tealbase-js@2.49.5-next.5";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  describe,
  it,
  afterEach,
} from "https://deno.land/std@0.224.0/testing/bdd.ts";
import { sleep } from "https://deno.land/x/sleep/mod.ts";

import { JWTPayload, SignJWT } from "https://deno.land/x/jose@v5.9.4/index.ts";

const env = await load();

const url = env["PROJECT_URL"];
const token = env["PROJECT_ANON_TOKEN"];
const jwtSecret = env["PROJECT_JWT_SECRET"];

const realtime = { heartbeatIntervalMs: 500, timeout: 1000 };
const config = { config: { broadcast: { self: true } } };

let tealbase: tealbaseClient | null;

afterEach(async () => {
  if (tealbase) await stopClient(tealbase);
  tealbase = null;
});

describe("broadcast extension", () => {
  it("user is able to receive self broadcast", async () => {
    tealbase = await createClient(url, token, { realtime });

    let result = null;
    let event = crypto.randomUUID();
    let topic = "topic:" + crypto.randomUUID();
    let expectedPayload = { message: crypto.randomUUID() };

    const channel = tealbase
      .channel(topic, config)
      .on("broadcast", { event }, ({ payload }) => (result = payload))
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);

    await channel.send({
      type: "broadcast",
      event,
      payload: expectedPayload,
    });

    while (result == null) await sleep(0.2);
    assertEquals(result, expectedPayload);
  });

  it("user is able to use the endpoint to broadcast", async () => {
    tealbase = await createClient(url, token, { realtime });

    let result = null;
    let event = crypto.randomUUID();
    let topic = "topic:" + crypto.randomUUID();
    let expectedPayload = { message: crypto.randomUUID() };
    const activeChannel = tealbase
      .channel(topic, config)
      .on("broadcast", { event }, ({ payload }) => (result = payload))
      .subscribe();
    while (activeChannel.state == "joining") await sleep(0.2);

    // Send from unsubscribed channel
    tealbase.channel(topic, config).send({
      type: "broadcast",
      event,
      payload: expectedPayload,
    });

    while (result == null) await sleep(0.2);

    assertEquals(result, expectedPayload);
  });
});

describe("presence extension", () => {
  it("user is able to receive presence updates", async () => {
    tealbase = await createClient(url, token, { realtime });

    let result: any = [];
    let error = null;
    let topic = "topic:" + crypto.randomUUID();
    let message = crypto.randomUUID();
    let key = crypto.randomUUID();
    let expectedPayload = { message };

    const config = { config: { broadcast: { self: true }, presence: { key } } };
    const channel = tealbase
      .channel(topic, config)
      .on("presence", { event: "join" }, ({ key, newPresences }) =>
        result.push({ key, newPresences })
      )
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);

    const res = await channel.track(expectedPayload, { timeout: 1000 });
    if (res == "timed out") error = res;

    let presences = result[0].newPresences[0];
    assertEquals(result[0].key, key);
    assertEquals(presences.message, message);
    assertEquals(error, null);
  });

  it("user is able to receive presence updates on private channels", async () => {
    tealbase = await createClient(url, token, { realtime });
    await signInUser(tealbase, "filipe@tealbase.io", "test_test");
    await tealbase.realtime.setAuth();

    let result: any = [];
    let error = null;
    let topic = "topic:" + crypto.randomUUID();
    let message = crypto.randomUUID();
    let key = crypto.randomUUID();
    let expectedPayload = { message };

    const config = {
      config: { private: true, broadcast: { self: true }, presence: { key } },
    };
    const channel = tealbase
      .channel(topic, config)
      .on("presence", { event: "join" }, ({ key, newPresences }) =>
        result.push({ key, newPresences })
      )
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);

    const res = await channel.track(expectedPayload, { timeout: 1000 });
    if (res == "timed out") error = res;

    let presences = result[0].newPresences[0];
    assertEquals(result[0].key, key);
    assertEquals(presences.message, message);
    assertEquals(error, null);
  });
});

describe("authorization check", () => {
  it("user using private channel cannot connect if does not have enough permissions", async () => {
    tealbase = await createClient(url, token, { realtime });

    let errMessage: any = null;
    let topic = "topic:" + crypto.randomUUID();

    const channel = tealbase
      .channel(topic, { config: { private: true } })
      .subscribe((status: string, err: any) => {
        if (status == "CHANNEL_ERROR") errMessage = err.message;
      });

    while (channel.state == "joining") await sleep(0.2);

    assertEquals(
      errMessage,
      `"You do not have permissions to read from this Channel topic: ${topic}"`
    );
  });

  it("user using private channel can connect if they have enough permissions", async () => {
    tealbase = await createClient(url, token, { realtime });
    await signInUser(tealbase, "filipe@tealbase.io", "test_test");
    await tealbase.realtime.setAuth();

    let topic = "topic:" + crypto.randomUUID();
    let connected = false;

    const channel = tealbase
      .channel(topic, { config: { private: true } })
      .subscribe((status: string) => {
        if (status == "SUBSCRIBED") connected = true;
      });

    while (channel.state == "joining") await sleep(0.2);

    assertEquals(connected, true);
  });

  it("user using private channel for jwt connections can connect if they have enough permissions based on claims", async () => {
    tealbase = await createClient(url, token, { realtime });

    let topic = "jwt_topic:" + crypto.randomUUID();
    let connected = false;
    let claims = { role: "authenticated", sub: "wallet_1" };
    let jwt_token = await generateJwtToken(claims);

    await tealbase.realtime.setAuth(jwt_token);

    const channel = tealbase
      .channel(topic, { config: { private: true } })
      .subscribe((status: string) => {
        if (status == "SUBSCRIBED") connected = true;
      });

    while (channel.state == "joining") await sleep(0.2);

    assertEquals(connected, true);
  });
});

describe("broadcast changes", () => {
  it("authenticated user receives insert broadcast change from a specific topic based on id", async () => {
    tealbase = await createClient(url, token, { realtime });
    await signInUser(tealbase, "filipe@tealbase.io", "test_test");
    await tealbase.realtime.setAuth();

    const table = "broadcast_changes";
    const id = crypto.randomUUID();
    const originalValue = crypto.randomUUID();
    const updatedValue = crypto.randomUUID();

    let insertResult: any, updateResult: any, deleteResult: any;

    const channel = tealbase
      .channel("topic:test", { config: { private: true } })
      .on("broadcast", { event: "INSERT" }, (res) => (insertResult = res))
      .on("broadcast", { event: "DELETE" }, (res) => (deleteResult = res))
      .on("broadcast", { event: "UPDATE" }, (res) => (updateResult = res))
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);

    // Test inserts
    await tealbase.from(table).insert({ value: originalValue, id });
    while (!insertResult) await sleep(0.2);
    assertEquals(insertResult.payload.record.id, id);
    assertEquals(insertResult.payload.record.value, originalValue);
    assertEquals(insertResult.payload.old_record, null);
    assertEquals(insertResult.payload.operation, "INSERT");
    assertEquals(insertResult.payload.schema, "public");
    assertEquals(insertResult.payload.table, "broadcast_changes");

    // Test updates
    await tealbase.from(table).update({ value: updatedValue }).eq("id", id);
    while (!updateResult) await sleep(0.2);
    assertEquals(updateResult.payload.record.id, id);
    assertEquals(updateResult.payload.record.value, updatedValue);
    assertEquals(updateResult.payload.old_record.id, id);
    assertEquals(updateResult.payload.old_record.value, originalValue);
    assertEquals(updateResult.payload.operation, "UPDATE");
    assertEquals(updateResult.payload.schema, "public");
    assertEquals(updateResult.payload.table, "broadcast_changes");

    // Test deletes
    await tealbase.from(table).delete().eq("id", id);
    while (!deleteResult) await sleep(0.2);
    assertEquals(deleteResult.payload.record, null);
    assertEquals(deleteResult.payload.old_record.id, id);
    assertEquals(deleteResult.payload.old_record.value, updatedValue);
    assertEquals(deleteResult.payload.operation, "DELETE");
    assertEquals(deleteResult.payload.schema, "public");
    assertEquals(deleteResult.payload.table, "broadcast_changes");
  });
});

describe("postgres changes extension", () => {
  it("user is able to receive INSERT only events from a subscribed table with filter applied", async () => {
    tealbase = await createClient(url, token, { realtime });
    await signInUser(tealbase, "filipe@tealbase.io", "test_test");
    await tealbase.realtime.setAuth();

    let subscribed = null;
    let result: any = null;
    let topic = "topic:" + crypto.randomUUID();

    let previousId = await executeInsert(tealbase, "pg_changes");
    await executeInsert(tealbase, "dummy");

    const channel = tealbase
      .channel(topic, config)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "pg_changes",
          filter: `id=eq.${previousId + 1}`,
        },
        (payload) => (result = payload)
      )
      .on("system", "*", ({ status }) => (subscribed = status))
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);
    while (subscribed != "ok") await sleep(0.2);

    await executeInsert(tealbase, "pg_changes");
    await executeInsert(tealbase, "dummy");

    while (result == null) await sleep(0.2);

    assertEquals(result.eventType, "INSERT");
    assertEquals(result.new.id, previousId + 1);
  });

  it("user is able to receive UPDATE only events from a subscribed table with filter applied", async () => {
    tealbase = await createClient(url, token, { realtime });
    await signInUser(tealbase, "filipe@tealbase.io", "test_test");
    await tealbase.realtime.setAuth();

    let result: any = null;
    let subscribed = null;
    let topic = "topic:" + crypto.randomUUID();

    let mainId = await executeInsert(tealbase, "pg_changes");
    let fakeId = await executeInsert(tealbase, "pg_changes");
    let dummyId = await executeInsert(tealbase, "dummy");

    const channel = tealbase
      .channel(topic, config)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "pg_changes",
          filter: `id=eq.${mainId}`,
        },
        (payload) => (result = payload)
      )
      .on("system", "*", ({ status }) => (subscribed = status))
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);
    while (subscribed != "ok") await sleep(0.2);

    executeUpdate(tealbase, "pg_changes", mainId);
    executeUpdate(tealbase, "pg_changes", fakeId);
    executeUpdate(tealbase, "dummy", dummyId);

    while (result == null) await sleep(0.2);

    assertEquals(result.eventType, "UPDATE");
    assertEquals(result.new.id, mainId);
  });

  it("user is able to receive DELETE only events from a subscribed table with filter applied", async () => {
    tealbase = await createClient(url, token, { realtime });
    await signInUser(tealbase, "filipe@tealbase.io", "test_test");
    await tealbase.realtime.setAuth();

    let result: any = null;
    let subscribed = null;
    let topic = "topic:" + crypto.randomUUID();

    let mainId = await executeInsert(tealbase, "pg_changes");
    let fakeId = await executeInsert(tealbase, "pg_changes");
    let dummyId = await executeInsert(tealbase, "dummy");

    const channel = tealbase
      .channel(topic, config)
      .on(
        "postgres_changes",
        {
          event: "DELETE",
          schema: "public",
          table: "pg_changes",
          filter: `id=eq.${mainId}`,
        },
        (payload) => (result = payload)
      )
      .on("system", "*", ({ status }) => (subscribed = status))
      .subscribe();

    while (channel.state == "joining") await sleep(0.2);
    while (subscribed != "ok") await sleep(0.2);

    executeDelete(tealbase, "pg_changes", mainId);
    executeDelete(tealbase, "pg_changes", fakeId);
    executeDelete(tealbase, "dummy", dummyId);

    while (result == null) await sleep(0.2);

    assertEquals(result.eventType, "DELETE");
    assertEquals(result.old.id, mainId);
  });
});

async function signInUser(
  tealbase: tealbaseClient,
  email: string,
  password: string
) {
  const { data, error } = await tealbase.auth.signInWithPassword({
    email,
    password,
  });
  if (error) throw new Error(`Error signing in: ${error.message}`);
  return data!.session!.access_token;
}

async function stopClient(tealbase: tealbaseClient) {
  await tealbase.removeAllChannels();
  await tealbase.auth.stopAutoRefresh();
  await tealbase.auth.signOut();
}

async function executeInsert(
  tealbase: tealbaseClient,
  table: string
): Promise<number> {
  const { data, error }: any = await tealbase
    .from(table)
    .insert([{ value: crypto.randomUUID() }])
    .select("id");

  if (error) throw new Error(`Error inserting data: ${error.message}`);
  return data[0].id;
}

async function executeUpdate(
  tealbase: tealbaseClient,
  table: string,
  id: number
) {
  const { data, error } = await tealbase
    .from(table)
    .update({ value: crypto.randomUUID() })
    .eq("id", id);

  if (error) throw new Error(`Error updating data: ${error.message}`);
  return data;
}

async function executeDelete(
  tealbase: tealbaseClient,
  table: string,
  id: number
) {
  const { data, error } = await tealbase.from(table).delete().eq("id", id);
  if (error) {
    throw new Error(`Error deleting data: ${error.message}`);
  }
  return data;
}

async function generateJwtToken(payload: JWTPayload) {
  const secret = new TextEncoder().encode(jwtSecret);
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);

  return jwt;
}
