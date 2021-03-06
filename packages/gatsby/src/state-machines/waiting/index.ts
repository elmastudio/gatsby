import { MachineConfig, assign, Machine } from "xstate"
import { IWaitingContext } from "./types"
import { waitingActions } from "./actions"
import { waitingServices } from "./services"

const NODE_MUTATION_BATCH_SIZE = 100
const NODE_MUTATION_BATCH_TIMEOUT = 1000

export type WaitingResult = Pick<IWaitingContext, "nodeMutationBatch">

/**
 * This idle state also handles batching of node mutations and running of
 * mutations when we first start it
 */
export const waitingStates: MachineConfig<IWaitingContext, any, any> = {
  id: `waitingMachine`,
  initial: `idle`,
  context: {
    nodeMutationBatch: [],
    runningBatch: [],
  },
  states: {
    idle: {
      always: {
        // If we already have queued node mutations, move
        // immediately to batching
        cond: (ctx): boolean => !!ctx.nodeMutationBatch.length,
        target: `batchingNodeMutations`,
      },
      on: {
        ADD_NODE_MUTATION: {
          actions: `addNodeMutation`,
          target: `batchingNodeMutations`,
        },
        // We only listen for this when idling because if we receive it at any
        // other point we're already going to create pages etc
        QUERY_FILE_CHANGED: {
          actions: `extractQueries`,
        },
      },
    },

    batchingNodeMutations: {
      // Check if the batch is already full on entry
      always: {
        cond: (ctx): boolean =>
          ctx.nodeMutationBatch.length >= NODE_MUTATION_BATCH_SIZE,
        target: `committingBatch`,
      },
      on: {
        // More mutations added to batch
        ADD_NODE_MUTATION: [
          // You know the score: only run the first matching transition
          {
            // If this fills the batch then commit it
            actions: `addNodeMutation`,
            cond: (ctx): boolean =>
              ctx.nodeMutationBatch.length >= NODE_MUTATION_BATCH_SIZE,
            target: `committingBatch`,
          },
          {
            // ...otherwise just add it to the batch
            actions: `addNodeMutation`,
          },
        ],
      },
      after: {
        // Time's up
        [NODE_MUTATION_BATCH_TIMEOUT]: `committingBatch`,
      },
    },
    committingBatch: {
      entry: assign<IWaitingContext>(({ nodeMutationBatch }) => {
        return {
          nodeMutationBatch: [],
          runningBatch: nodeMutationBatch,
        }
      }),
      on: {
        // While we're running the batch we need to batch any incoming mutations too
        ADD_NODE_MUTATION: {
          actions: `addNodeMutation`,
        },
      },
      invoke: {
        src: `runMutationBatch`,
        // When we're done, clear the running batch ready for next time
        onDone: {
          actions: assign<IWaitingContext, any>({
            runningBatch: [],
          }),
          target: `rebuild`,
        },
      },
    },
    rebuild: {
      type: `final`,
      // This is returned to the parent. The batch includes
      // any mutations that arrived while we were running the other batch
      data: ({ nodeMutationBatch }): WaitingResult => {
        return { nodeMutationBatch }
      },
    },
  },
}

export const waitingMachine = Machine(waitingStates, {
  actions: waitingActions,
  services: waitingServices,
})
