const {
  teamsTools,
  handleListChats,
  handleGetChatMessages,
  handleSendChatMessage,
} = require('../../teams');
const handleListChatsDirect = require('../../teams/list-chats');
const handleGetChatMessagesDirect = require('../../teams/get-chat-messages');
const handleSendChatMessageDirect = require('../../teams/send-chat-message');

describe('teams tool definitions', () => {
  it('exports exactly the three approved Teams chat tools in order', () => {
    expect(teamsTools.map((tool) => tool.name)).toEqual([
      'list-chats',
      'get-chat-messages',
      'send-chat-message',
    ]);
  });

  it('exposes required fields per tool', () => {
    const listChats = teamsTools.find((tool) => tool.name === 'list-chats');
    const getChatMessages = teamsTools.find((tool) => tool.name === 'get-chat-messages');
    const sendChatMessage = teamsTools.find((tool) => tool.name === 'send-chat-message');

    expect(listChats.inputSchema.required).toEqual([]);

    expect(getChatMessages.inputSchema.required).toEqual(['chatId']);
    expect(getChatMessages.inputSchema.properties).toHaveProperty('receivedAfter');
    expect(getChatMessages.inputSchema.properties).toHaveProperty('receivedBefore');
    expect(getChatMessages.inputSchema.properties).toHaveProperty('nextLink');

    expect(sendChatMessage.inputSchema.required).toEqual(['chatId', 'content']);
    expect(sendChatMessage.inputSchema.properties.contentType.enum).toEqual(['text', 'html']);
  });

  it('binds each definition to its handler module', () => {
    const listChats = teamsTools.find((tool) => tool.name === 'list-chats');
    const getChatMessages = teamsTools.find((tool) => tool.name === 'get-chat-messages');
    const sendChatMessage = teamsTools.find((tool) => tool.name === 'send-chat-message');

    expect(listChats.handler).toBe(handleListChats);
    expect(getChatMessages.handler).toBe(handleGetChatMessages);
    expect(sendChatMessage.handler).toBe(handleSendChatMessage);
    expect(handleListChatsDirect).toBe(handleListChats);
    expect(handleGetChatMessagesDirect).toBe(handleGetChatMessages);
    expect(handleSendChatMessageDirect).toBe(handleSendChatMessage);
  });
});
