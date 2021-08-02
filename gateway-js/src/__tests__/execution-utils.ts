import {
  GraphQLSchemaValidationError,
  GraphQLSchemaModule,
  GraphQLResolverMap,
} from 'apollo-graphql';
import { GraphQLRequest, GraphQLExecutionResult, Logger } from 'apollo-server-types';
import {
  composeAndValidate,
  ServiceDefinition,
  compositionHasErrors,
} from '@apollo/federation';
import { buildSubgraphSchema } from '@apollo/subgraph';
import {
  executeQueryPlan,
  buildOperationContext,
} from '@apollo/gateway';
import { QueryPlan, NewQueryPlanner, QueryPlanner } from '@apollo/query-planner';
import { LocalGraphQLDataSource } from '../datasources/LocalGraphQLDataSource';
import { mergeDeep } from 'apollo-utilities';

import { queryPlanSerializer, astSerializer } from 'apollo-federation-integration-testsuite';
import gql from 'graphql-tag';
import { fixtures } from 'apollo-federation-integration-testsuite';
import * as graphql from 'graphql';
import { mergeSubgraphs, validateGraphComposition } from '@apollo/composition';
import { buildSchemaFromAST, federationBuiltIns, printSchema, Schema } from '@apollo/core';
import { buildGraph, buildSubgraphsFederation } from '@apollo/query-graphs';

const prettyFormat = require('pretty-format');

export type ServiceDefinitionModule = ServiceDefinition & GraphQLSchemaModule;

export function overrideResolversInService(
  module: ServiceDefinitionModule,
  resolvers: GraphQLResolverMap,
): ServiceDefinitionModule {
  return {
    name: module.name,
    typeDefs: module.typeDefs,
    resolvers: mergeDeep(module.resolvers, resolvers),
  };
}

export async function execute(
  request: GraphQLRequest,
  services: ServiceDefinitionModule[] = fixtures,
  logger: Logger = console,
): Promise<GraphQLExecutionResult & { queryPlan: QueryPlan }> {
  const serviceMap = Object.fromEntries(
    services.map(({ name, typeDefs, resolvers }) => {
      return [
        name,
        new LocalGraphQLDataSource(
          buildSubgraphSchema([{ typeDefs, resolvers }]),
        ),
      ] as [string, LocalGraphQLDataSource];
    }),
  );

  const { schema, queryPlanner } = getFederatedTestingSchema(services);

  const operationContext = buildOperationContext({
    schema,
    operationDocument: gql`${request.query}`,
  });

  const queryPlan = queryPlanner.buildQueryPlan(operationContext);

  const result = await executeQueryPlan(
    queryPlan,
    serviceMap,
     // @ts-ignore
    {
      cache: undefined as any,
      context: {},
      request,
      logger
    },
    operationContext,
  );

  return { ...result, queryPlan };
}

export function buildLocalService(modules: GraphQLSchemaModule[]) {
  const schema = buildSubgraphSchema(modules);
  return new LocalGraphQLDataSource(schema);
}

export function getFederatedTestingSchema(services: ServiceDefinitionModule[] = fixtures) {
  const serviceMap = Object.fromEntries(
    services.map((service) => [
      service.name,
      buildLocalService([service]),
    ]),
  );

  const subgraphMap = new Map<string, Schema>();
  for (const [name, dataSource] of Object.entries(serviceMap)) {
    const schema = buildSchemaFromAST(dataSource.sdl(), federationBuiltIns);
    schema.validate();
    subgraphMap.set(name, schema);
  }

  const mergeResult = mergeSubgraphs(subgraphMap);
  if (mergeResult.errors) {
    throw new GraphQLSchemaValidationError(mergeResult.errors);
  }

  const supergraphSchema = mergeResult.supergraph;

  const queryGraph = buildSubgraphsFederation(supergraphSchema, subgraphMap);

  const supergraphGraph = buildGraph("supergraph", supergraphSchema);
  const compositionResult = validateGraphComposition(supergraphGraph, queryGraph);
  if (compositionResult.error) {
    throw compositionResult.error;
  }

  if (compositionResult.error) {
    throw compositionResult.error;
  }

  const schema = graphql.buildSchema(printSchema(supergraphSchema));

  const queryPlanner = new NewQueryPlanner(supergraphSchema, queryGraph) as unknown as QueryPlanner;

  return { serviceMap, schema, queryPlanner };
}

export function getTestingSupergraphSdl(services: typeof fixtures = fixtures) {
  const compositionResult = composeAndValidate(services);
  if (!compositionHasErrors(compositionResult)) {
    return compositionResult.supergraphSdl;
  }
  throw new Error("Testing fixtures don't compose properly!");
}

export function wait(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export function printPlan(queryPlan: QueryPlan): string {
  return prettyFormat(queryPlan, {
    plugins: [queryPlanSerializer, astSerializer],
  });
}
