import React from "react";

function ChatMessage({ message }) {
  const isUser = message.role === "user";
  const bubbleStyle = {
    alignSelf: isUser ? "flex-end" : "flex-start",
    background: isUser ? "#10a37f" : "#565869", // Couleur de fond différente pour user et system
    padding: "10px",
    borderRadius: "5px",
    maxWidth: "60%",
    whiteSpace: "pre-wrap",
    wordWrap: "break-word",
    color: "#ffffff", // Texte en blanc
  };

  return <div style={bubbleStyle}>{message.content}</div>;
}

export default ChatMessage;
