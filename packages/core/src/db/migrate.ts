import { Resource } from "sst";
import { connect, migrateToLatest } from "./client.js";

const db = connect(Resource.DatabaseUrl.value);
await migrateToLatest(db);
await db.destroy();
