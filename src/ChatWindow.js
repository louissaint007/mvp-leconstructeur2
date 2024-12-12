import React from 'react';
import ChatMessage from './ChatMessage';

function ChatWindow({ messages }) {
  const containerStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px'
  };

  return (
    <div style={containerStyle}>
      {messages.map((msg, index) => (
        <ChatMessage key={index} message={msg} />
      ))}
    </div>
  );
}

export default ChatWindow;