import {
  graphEntityDetailInput,
  graphFromDocumentInput,
  graphNeighborhoodInput,
  graphRelationDetailInput,
  searchGraphEntitiesInput,
} from "~/server/api/schemas/graph";
import { authedProcedure, createTRPCRouter } from "~/server/api/trpc";
import {
  getGraphEntityDetail,
  getGraphNeighborhood,
  getGraphRelationDetail,
  graphFromDocument,
  searchGraphEntities,
} from "@weaver/core/services/graph";

export const graphRouter = createTRPCRouter({
  searchEntities: authedProcedure
    .input(searchGraphEntitiesInput)
    .query(({ ctx, input }) =>
      searchGraphEntities(ctx.db, input, ctx.security),
    ),
  fromDocument: authedProcedure
    .input(graphFromDocumentInput)
    .query(({ ctx, input }) => graphFromDocument(ctx.db, input, ctx.security)),
  neighborhood: authedProcedure
    .input(graphNeighborhoodInput)
    .query(({ ctx, input }) =>
      getGraphNeighborhood(ctx.db, input, ctx.security),
    ),
  entityDetail: authedProcedure
    .input(graphEntityDetailInput)
    .query(({ ctx, input }) =>
      getGraphEntityDetail(ctx.db, input, ctx.security),
    ),
  relationDetail: authedProcedure
    .input(graphRelationDetailInput)
    .query(({ ctx, input }) =>
      getGraphRelationDetail(ctx.db, input, ctx.security),
    ),
});
