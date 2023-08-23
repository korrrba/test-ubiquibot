import { Context } from "probot";
import { createLogger } from "@logdna/logger";
import { createAdapters } from "../adapters";
import { processors, wildcardProcessors } from "../handlers/processors";
import { shouldSkip } from "../helpers";
import { BotConfig, GithubEvent, Payload, PayloadSchema } from "../types";
import { Adapters } from "../types/adapters";
import { ajv } from "../utils";
import { loadConfig } from "./config";

let botContext: Context = {} as Context;
export const getBotContext = () => botContext;

let botConfig: BotConfig = {} as BotConfig;
export const getBotConfig = () => botConfig;

let adapters: Adapters = {} as Adapters;
export const getAdapters = () => adapters;

export type Logger = {
  info: (msg: string | object, options?: JSON) => void;
  debug: (msg: string | object, options?: JSON) => void;
  warn: (msg: string | object, options?: JSON) => void;
  error: (msg: string | object, options?: JSON) => void;
};
let logger: Logger;
export const getLogger = (): Logger => logger;

const NO_VALIDATION = [GithubEvent.INSTALLATION_ADDED_EVENT as string, GithubEvent.PUSH_EVENT as string];

export const bindEvents = async (context: Context): Promise<void> => {
  const { id, name } = context;
  botContext = context;
  const payload = context.payload as Payload;

  botConfig = await loadConfig(context);
  const { log } = getBotContext();
  const options = {
    app: "UbiquiBot",
    level: botConfig.log.level,
  };
  logger = createLogger(botConfig.log.ingestionKey, options) as Logger;
  if (!logger) {
    return;
  }

  log.info(
    `Config loaded! config: ${JSON.stringify({
      price: botConfig.price,
      unassign: botConfig.unassign,
      mode: botConfig.mode,
      log: botConfig.log,
      wallet: botConfig.wallet,
    })}`
  );
  const allowedEvents = Object.values(GithubEvent) as string[];
  log.info("-- raw event payload start --");
  log.info(payload);
  log.info("-- raw event payload end --");
  const eventName = payload.action ? `${name}.${payload.action}` : name; // some events wont have actions as this grows

  log.info(`Started binding events... id: ${id}, name: ${eventName}, allowedEvents: ${allowedEvents}`);

  if (!allowedEvents.includes(eventName)) {
    // just check if its on the watch listt
    log.info(`Skipping the event. reason: not configured`);
    return;
  }

  // Create adapters for telegram, supabase, twitter, discord, etc
  log.info("Creating adapters for supabase, telegram, twitter, etc...");
  adapters = createAdapters(botConfig);

  // Skip validation for installation event and push
  if (!NO_VALIDATION.includes(eventName)) {
    // Validate payload
    const validate = ajv.compile(PayloadSchema);
    const valid = validate(payload);
    if (!valid) {
      log.info("Payload schema validation failed!!!", payload);
      if (validate.errors) logger.warn(validate.errors);
      return;
    }

    // Check if we should skip the event
    const { skip, reason } = shouldSkip();
    if (skip) {
      log.info(`Skipping the event. reason: ${reason}`);
      return;
    }
  }

  // Get the handlers for the action
  const handlers = processors[eventName];
  if (!handlers) {
    logger.warn(`No handler configured for event: ${eventName}`);
    return;
  }

  const { pre, action, post } = handlers;
  // Run pre-handlers
  log.info(`Running pre handlers: ${pre.map((fn) => fn.name)}, event: ${eventName}`);
  for (const preAction of pre) {
    await preAction();
  }
  // Run main handlers
  log.info(`Running main handlers: ${action.map((fn) => fn.name)}, event: ${eventName}`);
  for (const mainAction of action) {
    await mainAction();
  }

  // Run post-handlers
  log.info(`Running post handlers: ${post.map((fn) => fn.name)}, event: ${eventName}`);
  for (const postAction of post) {
    await postAction();
  }

  // Skip wildcard handlers for installation event
  if (eventName !== GithubEvent.INSTALLATION_ADDED_EVENT) {
    // Run wildcard handlers
    log.info(`Running wildcard handlers: ${wildcardProcessors.map((fn) => fn.name)}`);
    for (const wildcardProcessor of wildcardProcessors) {
      await wildcardProcessor();
    }
  }
};
