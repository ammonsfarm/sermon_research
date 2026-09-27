import type { D1Database, D1PreparedStatement, D1ProcessingStateStore, D1PublicContentRepository, D1UserAccessRepository } from "../src/index.ts";
import type { ProcessingStateStore, PublicContentRepository, UserAccessRepository } from "@aic/contracts";

declare const db: D1Database;
declare const statement: D1PreparedStatement;
declare const content: D1PublicContentRepository;
declare const access: D1UserAccessRepository;
declare const processing: D1ProcessingStateStore;
const prepared: D1PreparedStatement = db.prepare("SELECT 1");
void prepared.bind("value");
void statement;
const publicContent: PublicContentRepository = content;
const userAccess: UserAccessRepository = access;
void publicContent;
void userAccess;
const processingState: ProcessingStateStore = processing;
void processingState;

// Provider-native types must not appear in the shared repository contract.
// @ts-expect-error The provider binding is intentionally not part of the contract.
publicContent.db;
