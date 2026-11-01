import { AssistantPage } from "../_components/AssistantPage";

export default async function AssistantConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <AssistantPage conversationId={conversationId} />;
}
