import { getBotContext, getLogger } from "../../bindings";
import { getAllIssueComments, parseComments } from "../../helpers";
import { Payload, UserType } from "../../types";
import { RewardsResponse, getWalletAddress } from "../comment";
import Decimal from "decimal.js";
import { IncentivesCalculationResult } from "./action";
import { BigNumber } from "ethers";
import { GLOBAL_STRINGS } from "../../configs";
import { calculateRewardValue } from "./calculate-reward-value";
import { walkComments } from "./walk-comments";
import { ItemsToExclude } from "./post";

/**
 * Incentivize the contributors based on their contribution.
 * The default formula has been defined in https://github.com/ubiquity/ubiquibot/issues/272
 */

export async function calculateIssueConversationReward(calculateIncentives: IncentivesCalculationResult): Promise<RewardsResponse | string> {
  const title = `Conversation`;
  const logger = getLogger();

  const context = getBotContext();
  const payload = context.payload as Payload;
  const issue = payload.issue;

  const permitComments = calculateIncentives.comments.filter(
    (content) => content.body.includes(title) && content.body.includes("https://pay.ubq.fi?claim=") && content.user.type == UserType.Bot
  );
  if (permitComments.length > 0) {
    logger.info(`incentivizeComments: skip to generate a permit url because it has been already posted`);
    return { error: `incentivizeComments: skip to generate a permit url because it has been already posted` };
  }

  for (const botComment of permitComments.filter((cmt) => cmt.user.type === UserType.Bot).reverse()) {
    const botCommentBody = botComment.body;
    if (botCommentBody.includes(GLOBAL_STRINGS.autopayComment)) {
      const pattern = /\*\*(\w+)\*\*/;
      const res = botCommentBody.match(pattern);
      if (res) {
        if (res[1] === "false") {
          return { error: "autopay is disabled" };
        }
        break;
      }
    }
  }

  const assignees = issue?.assignees ?? [];
  const assignee = assignees.length > 0 ? assignees[0] : undefined;
  if (!assignee) return logger.info("incentivizeComments: skipping payment permit generation because `assignee` is `undefined`.");

  const issueComments = await getAllIssueComments(calculateIncentives.issue.number, "raw");
  logger.info(`Getting the issue comments done. comments: ${JSON.stringify(issueComments)}`);
  const issueCommentsByUser: Record<string, { id: string; comments: string[] }> = {};

  walkComments({ issueComments, assignee, logger, issueCommentsByUser });

  logger.info(`Filtering by the user type done. commentsByUser: ${JSON.stringify(issueCommentsByUser)}`);

  // The mapping between gh handle and amount in big number
  const fallbackReward: Record<string, Decimal> = {};

  // array of awaiting permits to generate
  const reward: { account: string; priceInBigNumber: Decimal; userId: string; user: string; penaltyAmount: BigNumber }[] = [];

  for (const _user of Object.keys(issueCommentsByUser)) {
    const commentsByUser = issueCommentsByUser[_user];
    const commentsByNode = parseComments(commentsByUser.comments, ItemsToExclude);
    const rewardValue = calculateRewardValue(commentsByNode, calculateIncentives.incentives);
    if (rewardValue.equals(0)) {
      logger.info(`Skipping to generate a permit url because the reward value is 0. user: ${_user}`);
      continue;
    }
    logger.debug(`Comment parsed for the user: ${_user}. comments: ${JSON.stringify(commentsByNode)}, sum: ${rewardValue}`);
    const account = await getWalletAddress(user.id);
    const priceInBigNumber = rewardValue.mul(calculateIncentives.baseMultiplier);
    if (priceInBigNumber.gt(calculateIncentives.permitMaxPrice)) {
      logger.info(`Skipping comment reward for user ${_user} because reward is higher than payment permit max price`);
      continue;
    }
    if (account) {
      reward.push({ account, priceInBigNumber, userId: commentsByUser.id, user: _user, penaltyAmount: BigNumber.from(0) });
    } else {
      fallbackReward[_user] = priceInBigNumber;
    }
  }

  return { error: "", title, reward, fallbackReward };
}
