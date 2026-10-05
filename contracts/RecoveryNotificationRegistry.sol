// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RecoveryNotificationRegistry {
    address public immutable operator;
    uint256 public nextNotificationId = 1;

    struct Notification {
        address owner;
        uint256 requestId;
        uint256 caseId;
        uint256 chainId;
        uint256 amountWei;
        address destination;
        uint64 expiresAt;
        string message;
        uint64 createdAt;
    }

    mapping(uint256 => Notification) public notifications;

    event RecoveryNotificationCreated(
        uint256 indexed notificationId,
        uint256 indexed requestId,
        address indexed owner,
        uint256 caseId,
        uint256 chainId,
        uint256 amountWei,
        address destination,
        uint64 expiresAt,
        string message
    );

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    constructor(address operator_) {
        require(operator_ != address(0), "invalid operator");
        operator = operator_;
    }

    function createNotification(
        address owner,
        uint256 requestId,
        uint256 caseId,
        uint256 chainId,
        uint256 amountWei,
        address destination,
        uint64 expiresAt,
        string calldata message
    ) external onlyOperator returns (uint256 notificationId) {
        require(owner != address(0), "invalid owner");
        require(destination != address(0), "invalid destination");
        require(bytes(message).length > 0, "message required");

        notificationId = nextNotificationId++;

        notifications[notificationId] = Notification({
            owner: owner,
            requestId: requestId,
            caseId: caseId,
            chainId: chainId,
            amountWei: amountWei,
            destination: destination,
            expiresAt: expiresAt,
            message: message,
            createdAt: uint64(block.timestamp)
        });

        emit RecoveryNotificationCreated(
            notificationId,
            requestId,
            owner,
            caseId,
            chainId,
            amountWei,
            destination,
            expiresAt,
            message
        );
    }
}
