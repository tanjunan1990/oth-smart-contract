// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

contract Ballot {

    // One topic on the ballot paper.
    struct Topic {
        string name;    // the topic being voted on
        uint voteCount; // how many votes it has received
    }

    // Which phase the ballot is in
    enum State { Setup, Voting, Closed }

    uint private constant MAX_TOPICS = 100;
    uint public immutable votingStart; // first moment a vote is accepted
    uint public immutable votingEnd;   // first moment a vote is refused
    address public immutable admin;    // may edit the blocklist, during Setup only

    // The topics. Only the constructor ever writes to this list.
    Topic[] private topics;

    // Accounts that are not allowed to vote.
    mapping(address => bool) public isBlocked;

    // Who has already used their one vote.
    mapping(address => bool) public hasVoted;

    event AccountBlocked(address indexed account);
    event VoteCast(address indexed voter, uint indexed topic);


    constructor(
        string[] memory topicNames,
        address[] memory blockedAccounts,
        uint votingStart_,
        uint votingEnd_
    ) {
        require(votingStart_ >= block.timestamp, "voting cannot start in the past");
        require(votingEnd_ > votingStart_, "voting must end after it starts");
        require(topicNames.length > 0, "there must be at least one topic");
        require(topicNames.length <= MAX_TOPICS, "too many topics");

        admin = msg.sender;
        votingStart = votingStart_;
        votingEnd = votingEnd_;

        // Solidity hash names compared
        bytes32[] memory seenNames = new bytes32[](topicNames.length);

        for (uint i = 0; i < topicNames.length; i++) {
            require(bytes(topicNames[i]).length > 0, "topic name cannot be empty");

            bytes32 nameHash = keccak256(bytes(topicNames[i]));
            for (uint j = 0; j < i; j++) {
                require(seenNames[j] != nameHash, "two topics have the same name");
            }
            seenNames[i] = nameHash;

            topics.push(Topic({ name: topicNames[i], voteCount: 0 }));
        }

        addToBlocklist(blockedAccounts);
    }

    /// Which phase we are in right now, worked out from the clock.
    function state() public view returns (State) {
        if (block.timestamp < votingStart) {
            return State.Setup;
        }
        if (block.timestamp < votingEnd) {
            return State.Voting;
        }
        return State.Closed;
    }

    /// Add accounts to the blocklist. Only the admin can call this.
    function blockAccounts(address[] memory accounts) public {
        require(msg.sender == admin, "only the admin can do this");
        require(block.timestamp < votingStart, "setup is over, voting has opened");

        addToBlocklist(accounts);
    }

    function addToBlocklist(address[] memory accounts) private {
        for (uint i = 0; i < accounts.length; i++) {
            address account = accounts[i];

            // Skip accounts already blocked
            if (!isBlocked[account]) {
                isBlocked[account] = true;

                emit AccountBlocked(account);
            }
        }
    }

    /// Cast your one vote for a topic. Only works while voting is open.
    function vote(uint topic) public {
        require(block.timestamp >= votingStart, "voting has not opened yet");
        require(block.timestamp < votingEnd, "voting has already closed");
        require(!isBlocked[msg.sender], "this account is not allowed to vote");
        require(!hasVoted[msg.sender], "this account has already voted");
        require(topic < topics.length, "no topic with that number");

        // Mark the voter first, so the same account can never get through twice.
        hasVoted[msg.sender] = true;
        topics[topic].voteCount = topics[topic].voteCount + 1;

        emit VoteCast(msg.sender, topic);
    }

    /// Every topic together with its current number of votes.
    function results() public view returns (Topic[] memory) {
        return topics;
    }

}