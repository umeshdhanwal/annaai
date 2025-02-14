import React, { useState, useRef, useCallback, useEffect } from 'react';
import { 
  StyleSheet, 
  View, 
  Text, 
  TouchableOpacity, 
  ScrollView, 
  KeyboardAvoidingView, 
  Platform,
  TextInput 
} from 'react-native';
import * as Speech from 'expo-speech';
import { MaterialIcons, Ionicons, FontAwesome5 } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import axios from 'axios';
import {
  WHISPER_URL,
  WHISPER_API_VERSION,
  WHISPER_KEY,
  GPT4_URL,
  GPT4_API_VERSION,
  GPT4_KEY,
  PIPEDRIVE_CLIENT_ID,
  PIPEDRIVE_CLIENT_SECRET
} from '@env';
import * as WebBrowser from 'expo-web-browser';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Markdown from 'react-native-markdown-display';

// Define the system prompt as a constant
const systemPrompt = `You are an AI assistant that converts natural language to Pipedrive API commands.
Output format: METHOD /endpoint

Base URL: https://api.pipedrive.com/api/v2
API Key: 33fc040bf2f77c8c19565076d44c22aa5792b291

Available endpoints and common use cases:

1. Deals:
- List all deals: GET /deals
- Search deals: GET /deals/search?term={search_term}
- Get specific deal: GET /deals/{id}
- Create deal: POST /deals
- Update deal: PATCH /deals/{id}
- Delete deal: DELETE /deals/{id}

2. Activities:
- List all activities: GET /activities
- Get specific activity: GET /activities/{id}
- Create activity: POST /activities
- Update activity: PATCH /activities/{id}
- Delete activity: DELETE /activities/{id}

3. Organizations:
- List all: GET /organizations
- Search: GET /organizations/search?term={search_term}
- Get details: GET /organizations/{id}
- Create: POST /organizations
- Update: PATCH /organizations/{id}
- Delete: DELETE /organizations/{id}

4. Persons:
- List all: GET /persons
- Search: GET /persons/search?term={search_term}
- Get details: GET /persons/{id}
- Create: POST /persons
- Update: PATCH /persons/{id}
- Delete: DELETE /persons/{id}

5. Notes:
- List all notes: GET /notes
- Get specific note: GET /notes/{id}
- Create note: POST /notes
- Update note: PATCH /notes/{id}
- Delete note: DELETE /notes/{id}

Example queries:
"Show me the biggest deals" -> "GET /deals?sort=value DESC&limit=5"
"Find person named John" -> "GET /persons/search?term=John"
"Get all activities for today" -> "GET /activities?due_date=today"
"Add note 'Called customer about proposal' to deal 123" -> "POST /notes with {content: 'Called customer about proposal', deal_id: 123}"
"Get notes for organization XYZ" -> "GET /organizations/search?term=XYZ" followed by "GET /notes?org_id={id}"

Get notes for organization XYZ" -> "GET /organizations/search?term=XYZ" followed by "GET /notes?org_id={id}"`;

const STAGE_MAPPING = {
  1: 'Qualified',
  2: 'Contact Made',
  3: 'Prospect Qualified',
  4: 'Needs Defined',
  5: 'Proposal Made',
  6: 'Negotiations Started'
};

const ChatScreen = ({ supabase }) => {
  const [isListening, setIsListening] = useState(false);
  const [recording, setRecording] = useState(null);
  const [message, setMessage] = useState('');
  const [chatHistory, setChatHistory] = useState([]);
  const scrollViewRef = useRef();
  const timeoutRef = useRef(null);
  const inputRef = useRef(null);
  const [awaitingNoteInput, setAwaitingNoteInput] = useState(null);
  const [hasPermission, setHasPermission] = useState(false);

  // Initialize with welcome message
  useEffect(() => {
    setChatHistory([{ 
      type: 'ai', 
      content: 'Hello! I can help you with Pipedrive CRM queries. Try asking about deals, activities, or organizations.' 
    }]);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const permission = await Audio.requestPermissionsAsync();
        setHasPermission(permission.status === 'granted');
        
        if (permission.status === 'granted') {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
            stopsRecordingWhenAppEntersBackground: true,
            interruptionModeIOS: 1,
            interruptionModeAndroid: 1,
          });
        } else {
          alert('Please grant microphone permissions to use voice input');
        }
      } catch (error) {
        console.error('Error requesting audio permissions:', error);
        setHasPermission(false);
      }
    })();
  }, []);

  const handleLogout = async () => {
    try {
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
    } catch (error) {
      console.error('Error logging out:', error);
      alert('Error logging out');
    }
  };

  const executePipedriveCommand = async (command, data = null) => {
    try {
      const [method, endpoint] = command.split(' ');
      const PIPEDRIVE_API_KEY = '33fc040bf2f77c8c19565076d44c22aa5792b291';
      
      const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
      const baseUrl = 'https://api.pipedrive.com/v1';
      const url = `${baseUrl}/${cleanEndpoint}`;
      const separator = url.includes('?') ? '&' : '?';
      const finalUrl = `${url}${separator}api_token=${PIPEDRIVE_API_KEY}`;

      const response = await axios({
        method: method.toLowerCase(),
        url: finalUrl,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        data: data
      });

      if (response.data && response.data.success === false) {
        throw new Error(response.data.error || 'Pipedrive API request failed');
      }

      return response.data;
    } catch (error) {
      console.error('Pipedrive API error:', error.response?.data || error.message);
      throw new Error(`Pipedrive API error: ${error.response?.data?.error || error.message}`);
    }
  };

  const formatPipedriveResponse = (data) => {
    if (!data || !data.data || data.data.length === 0) {
      return "I couldn't find any matching deals or records.";
    }

    if (Array.isArray(data.data)) {
      const items = data.data.map(item => {
        if (item.title) { // Deal
          const value = item.value ? `${item.value} ${item.currency}` : 'No value set';
          // Map stage_id to stage name
          const stage = item.stage_id ? STAGE_MAPPING[item.stage_id] || `Unknown stage (${item.stage_id})` : 'Unknown stage';
          const owner = item.owner_name || (item.user && item.user.name) || 'Unassigned';
          const addedDate = item.add_time ? new Date(item.add_time).toLocaleDateString() : 'Date not available';
          
          return `📊 Deal: ${item.title}\n💰 Value: ${value}\n📈 Stage: ${stage}\n👤 Owner: ${owner}\n📅 Added: ${addedDate}`;
        } else if (item.content) { // Note
          const date = item.add_time ? new Date(item.add_time).toLocaleDateString() : 'Date not available';
          return `📝 Note: ${item.content}\n📅 Created: ${date}`;
        }
        return Object.entries(item)
          .filter(([key, value]) => typeof value !== 'object')
          .map(([key, value]) => `${key}: ${value}`)
          .join('\n');
      });

      if (items.length === 0) {
        return "No matching records found.";
      } else if (items.length === 1) {
        return items[0];
      } else {
        return `I found ${items.length} items:\n\n${items.join('\n\n')}`;
      }
    }

    return `Here's what I found:\n${JSON.stringify(data.data, null, 2)}`;
  };

  const processApiResponse = async (apiResponse, userQuery) => {
    try {
      // First attempt to get direct response
      const formattedResponse = formatPipedriveResponse(apiResponse);
      
      // Send to GPT to generate natural language response
      const responsePrompt = `
Given the user query: "${userQuery}"
And the Pipedrive API response: ${formattedResponse}

Please provide a natural language response that:
1. Answers the user's question directly
2. Highlights key information
3. Suggests relevant follow-up questions
4. Indicates if additional API calls might be needed for complete information

If the response doesn't fully answer the query, specify what additional information is needed.`;

      const gptResponse = await axios.post(
        `${GPT4_URL}?api-version=${GPT4_API_VERSION}`,
        {
          messages: [{
            role: 'system',
            content: responsePrompt
          }],
          max_tokens: 250
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'api-key': GPT4_KEY
          }
        }
      );

      return gptResponse.data.choices[0].message.content;
    } catch (error) {
      console.error('Error processing API response:', error);
      return formattedResponse;
    }
  };

  const handleUserQuery = async (query) => {
    try {
      // Check for organization notes request
      const notesMatch = query.toLowerCase().match(/(?:get|show|find)?\s*(?:notes|nodes)\s+(?:for|from)\s+(?:organization|org|company)?\s*(.+)/i);
      
      if (notesMatch) {
        const orgName = notesMatch[1].trim();
        return await getOrganizationNotes(orgName);
      }

      // Continue with regular GPT processing
      const gptResponse = await axios.post(
        `${GPT4_URL}?api-version=${GPT4_API_VERSION}`,
        {
          messages: [{
            role: 'system',
            content: systemPrompt
          }, {
            role: 'user',
            content: query
          }],
          max_tokens: 150
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'api-key': GPT4_KEY
          }
        }
      );

      const apiCommand = gptResponse.data.choices[0].message.content;
      const apiResponse = await executePipedriveCommand(apiCommand);
      return await processApiResponse(apiResponse, query);
    } catch (error) {
      throw new Error(`Failed to process query: ${error.message}`);
    }
  };

  const handlePromptClick = useCallback(async (prompt) => {
    try {
      const userMessage = { type: 'user', content: prompt };
      setChatHistory(prev => [...prev, userMessage]);

      let response;
      let formattedResponse;

      switch (prompt) {
        case "Get the highest deal":
          response = await executePipedriveCommand('GET /deals?status=open&sort=value DESC&limit=1');
          const highestDeal = response.data && response.data.length > 0 ? response.data[0] : null;
          
          if (highestDeal) {
            const allDealsResponse = await executePipedriveCommand('GET /deals?status=open');
            const allDeals = allDealsResponse.data || [];
            
            // Sort all deals by value in descending order
            const sortedDeals = allDeals.sort((a, b) => {
              const valueA = parseFloat(a.value) || 0;
              const valueB = parseFloat(b.value) || 0;
              return valueB - valueA;
            });

            // Get the highest value deal
            const actualHighestDeal = sortedDeals[0];
            formattedResponse = actualHighestDeal 
              ? `Here's the deal with the highest value:\n\n${formatPipedriveResponse({ data: [actualHighestDeal] })}` 
              : "No deals found";
          } else {
            formattedResponse = "No deals found";
          }
          break;
        
        case "Proposal made in last 5 days":
          const fiveDaysAgo = new Date();
          fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
          const formattedDate = fiveDaysAgo.toISOString().split('T')[0];
          response = await executePipedriveCommand(`GET /deals?status=open&stage_id=5&start_date=${formattedDate}`);
          formattedResponse = `Here are the deals in Proposal Made stage from the last 5 days:\n\n${formatPipedriveResponse(response)}`;
          break;
        
        case "Top Deal in negotiation stage":
          response = await executePipedriveCommand('GET /deals?status=open&stage_id=6&sort=value DESC&limit=1');
          formattedResponse = `Here's the top deal in Negotiations Started stage:\n\n${formatPipedriveResponse(response)}`;
          break;
        
        case "Get notes for qualified prospects":
          // First get deals in Prospect Qualified stage
          response = await executePipedriveCommand('GET /deals?status=open&stage_id=3');
          const qualifiedDeals = response.data || [];
          
          if (qualifiedDeals.length > 0) {
            // Get deal IDs
            const dealIds = qualifiedDeals.map(deal => deal.id);
            // Get notes for these deals
            const notesResponse = await executePipedriveCommand(`GET /notes?deal_id=${dealIds.join(',')}`);
            formattedResponse = `Here are the notes for Prospect Qualified deals:\n\n${formatPipedriveResponse(notesResponse)}`;
          } else {
            formattedResponse = "No qualified prospects found.";
          }
          break;
        
        default:
          throw new Error('Unknown command');
      }

      const aiResponse = { 
        type: 'ai', 
        content: formattedResponse 
      };
      
      setChatHistory(prev => [...prev, aiResponse]);
      setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (error) {
      console.error('Error:', error);
      setChatHistory(prev => [...prev, { 
        type: 'ai', 
        content: `Error: ${error.message}` 
      }]);
    }
  }, []);

  const handleSendMessage = useCallback(async () => {
    if (!message.trim()) return;
    
    const userMessage = { type: 'user', content: message.trim() };
    setChatHistory(prev => [...prev, userMessage]);
    setMessage('');
    
    try {
      if (awaitingNoteInput) {
        switch (awaitingNoteInput.stage) {
          case 'single_note_input':
            const response = await executePipedriveCommand(`POST /notes`, {
              content: message.trim(),
              deal_id: awaitingNoteInput.deal.id
            });
            
            if (response.success) {
              setChatHistory(prev => [...prev, { 
                type: 'ai', 
                content: `✅ Note added to deal "${awaitingNoteInput.deal.title}"` 
              }]);
            } else {
              throw new Error('Failed to add note');
            }
            setAwaitingNoteInput(null);
            break;
            
          case 'org_selection':
            const orgIndex = parseInt(message) - 1;
            if (orgIndex >= 0 && orgIndex < awaitingNoteInput.orgList.length) {
              const selectedOrg = awaitingNoteInput.orgList[orgIndex];
              const orgDeals = awaitingNoteInput.dealsByOrg[selectedOrg];
              
              // Show deals for selected organization
              const dealsMessage = orgDeals.map((deal, index) => 
                `${index + 1}. ${deal.title} (${deal.value} ${deal.currency})`
              ).join('\n');
              
              setChatHistory(prev => [...prev, { 
                type: 'ai', 
                content: `Deals for ${selectedOrg}:\n\n${dealsMessage}\n\nPlease enter the deal number followed by your note (e.g., "1 Called about proposal status")` 
              }]);
              
              setAwaitingNoteInput({
                stage: 'note_input',
                deals: orgDeals,
                selectedOrg,
                stageName: awaitingNoteInput.stageName
              });
            } else {
              setChatHistory(prev => [...prev, { 
                type: 'ai', 
                content: 'Invalid organization number. Please try again.' 
              }]);
            }
            break;
            
          case 'note_input':
            const [dealNum, ...noteParts] = message.trim().split(' ');
            const noteContent = noteParts.join(' ');
            const dealIndex = parseInt(dealNum) - 1;
            
            if (dealIndex >= 0 && dealIndex < awaitingNoteInput.deals.length) {
              const selectedDeal = awaitingNoteInput.deals[dealIndex];
              const response = await executePipedriveCommand('POST /notes', {
                content: noteContent,
                deal_id: selectedDeal.id
              });
              
              setChatHistory(prev => [...prev, { 
                type: 'ai', 
                content: `✅ Note added to deal "${selectedDeal.title}" for ${awaitingNoteInput.selectedOrg}` 
              }]);
            } else {
              setChatHistory(prev => [...prev, { 
                type: 'ai', 
                content: 'Invalid deal number. Please try again.' 
              }]);
            }
            setAwaitingNoteInput(null);
            break;
        }
      } else {
        const response = await handleUserQuery(message.trim());
        const aiResponse = { type: 'ai', content: response };
        setChatHistory(prev => [...prev, aiResponse]);
      }
    } catch (error) {
      setChatHistory(prev => [...prev, { 
        type: 'ai', 
        content: `Error: ${error.message}` 
      }]);
    }
    
    requestAnimationFrame(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    });
  }, [message, awaitingNoteInput]);

  const startRecording = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        alert('Please grant microphone permissions to use voice input');
        return;
      }

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });

      const { recording: newRecording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY
      );
      setRecording(newRecording);
      setIsListening(true);
    } catch (error) {
      console.error('Failed to start recording:', error);
      setIsListening(false);
    }
  };

  const stopRecording = async () => {
    try {
      if (!recording) return;

      setIsListening(false);
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);

      // Create form data for the audio file
      const formData = new FormData();
      formData.append('file', {
        uri,
        type: 'audio/m4a',
        name: 'recording.m4a'
      });

      console.log('Sending audio to Whisper API...');
      const response = await axios.post(WHISPER_URL, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'api-key': WHISPER_KEY
        }
      });

      if (response.data?.text) {
        const transcribedText = response.data.text.trim();
        
        // Add user message to chat history
        setChatHistory(prev => [...prev, { type: 'user', content: transcribedText }]);

        try {
          // Process through handleUserQuery like manual input
          const aiResponse = await handleUserQuery(transcribedText);
          setChatHistory(prev => [...prev, { type: 'ai', content: aiResponse }]);
        } catch (error) {
          console.error('Error processing query:', error);
          let errorMessage = "I apologize, but I couldn't process that request. ";
          
          if (error.message.includes('400')) {
            errorMessage += "The request wasn't formatted correctly. Could you try rephrasing your question?";
          } else if (error.message.includes('404')) {
            errorMessage += "I couldn't find what you're looking for. Please verify the information and try again.";
          } else {
            errorMessage += "There was an issue connecting to Pipedrive. Please try again in a moment.";
          }
          
          setChatHistory(prev => [...prev, { 
            type: 'ai', 
            content: errorMessage
          }]);
        }
      }
    } catch (error) {
      console.error('Failed to process voice:', error.response?.data || error.message);
      setChatHistory(prev => [...prev, { 
        type: 'ai', 
        content: "I'm sorry, but I had trouble understanding the audio. Could you please try speaking again or type your question?" 
      }]);
    }
  };

  const addNoteToStageDeals = async (stageId, stageName) => {
    try {
      // First get all deals in specified stage
      const response = await executePipedriveCommand(`GET /deals?status=open&stage_id=${stageId}`);
      const stageDeals = response.data || [];
      
      if (stageDeals.length === 1) {
        // If there's only one deal, directly ask for note input
        const deal = stageDeals[0];
        setChatHistory(prev => [...prev, { 
          type: 'ai', 
          content: `Found one deal in ${stageName} stage:\n${deal.title} (${deal.value} ${deal.currency})\n\nPlease enter your note or use voice input.` 
        }]);
        
        setAwaitingNoteInput({
          stage: 'single_note_input',
          deal: deal,
          stageName
        });
      } else if (stageDeals.length > 1) {
        // Multiple deals - group by organization as before
        const dealsByOrg = stageDeals.reduce((acc, deal) => {
          const orgName = deal.org_id?.name || 'No Organization';
          if (!acc[orgName]) {
            acc[orgName] = [];
          }
          acc[orgName].push(deal);
          return acc;
        }, {});
        
        const orgsMessage = Object.keys(dealsByOrg)
          .map((orgName, index) => `${index + 1}. ${orgName} (${dealsByOrg[orgName].length} deals)`)
          .join('\n');
        
        setChatHistory(prev => [...prev, { 
          type: 'ai', 
          content: `Found deals in ${stageName} stage for these organizations:\n\n${orgsMessage}\n\nPlease enter the organization number to see its deals.` 
        }]);
        
        setAwaitingNoteInput({
          stage: 'org_selection',
          dealsByOrg,
          orgList: Object.keys(dealsByOrg),
          stageName
        });
      } else {
        setChatHistory(prev => [...prev, { 
          type: 'ai', 
          content: `No deals found in ${stageName} stage.` 
        }]);
      }
    } catch (error) {
      console.error('Error:', error);
      setChatHistory(prev => [...prev, { 
        type: 'ai', 
        content: `Error: ${error.message}` 
      }]);
    }
  };

  const getOrganizationNotes = async (orgName) => {
    try {
      // Search for organization with fuzzy matching
      const searchTerm = orgName.toLowerCase().replace(/nodes/i, 'notes');
      const orgResponse = await executePipedriveCommand(`GET /organizations/search?term=${encodeURIComponent(searchTerm)}`);
      
      // Check the correct data structure from Pipedrive API
      const organizations = orgResponse?.data?.items || [];

      if (organizations.length === 0) {
        return `No organization found matching "${orgName}"`;
      }

      // Find the closest matching organization
      let closestOrg = null;
      let smallestDistance = Infinity;

      for (const org of organizations) {
        if (!org.item || !org.item.name) continue;
        
        const distance = levenshteinDistance(org.item.name.toLowerCase(), searchTerm);
        if (distance < smallestDistance) {
          smallestDistance = distance;
          closestOrg = org.item;
        }
      }

      if (!closestOrg) {
        return `No valid organization found matching "${orgName}"`;
      }

      // Get notes for the matched organization
      const notesResponse = await executePipedriveCommand(`GET /notes?org_id=${closestOrg.id}`);
      const notes = notesResponse?.data || [];

      if (notes.length === 0) {
        return `No notes found for organization "${closestOrg.name}"`;
      }

      // Format notes with timestamps
      const formattedNotes = notes.map(note => {
        const date = new Date(note.add_time).toLocaleDateString();
        return `📝 ${date}: ${note.content}`;
      }).join('\n\n');

      return `Notes for ${closestOrg.name}:\n\n${formattedNotes}`;
    } catch (error) {
      console.error('Error:', error);
      throw new Error(`Failed to get organization notes: ${error.message}`);
    }
  };

  // Helper function for fuzzy matching
  const levenshteinDistance = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array(a.length + 1).fill().map(() => Array(b.length + 1).fill(0));

    for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
    for (let j = 0; j <= b.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }
    return matrix[a.length][b.length];
  };

  useEffect(() => {
    return () => {
      if (recording) {
        recording.stopAndUnloadAsync();
      }
    };
  }, [recording]);

  return (
    <View style={styles.container}>
      <View style={styles.mainContent}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <MaterialIcons name="logout" size={24} color="#FFFFFF" />
        </TouchableOpacity>

        <Text style={styles.header}>Chat with Anna.ai</Text>

        <ScrollView 
          style={styles.chatContainer}
          ref={scrollViewRef}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.optionsContainer}>
            <TouchableOpacity 
              style={styles.option}
              onPress={() => handlePromptClick("Get the highest deal")}
            >
              <MaterialIcons name="trending-up" size={24} color="#4CAF50" />
              <Text style={styles.optionText}>Get the highest deal</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.option}
              onPress={() => handlePromptClick("Proposal made in last 5 days")}
            >
              <MaterialIcons name="date-range" size={24} color="#FF9800" />
              <Text style={styles.optionText}>Proposal made in last 5 days</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.option}
              onPress={() => handlePromptClick("Top Deal in negotiation stage")}
            >
              <MaterialIcons name="handshake" size={24} color="#2196F3" />
              <Text style={styles.optionText}>Top Deal in negotiation stage</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.option}
              onPress={() => handlePromptClick("Get notes for qualified prospects")}
            >
              <MaterialIcons name="note" size={24} color="#E91E63" />
              <Text style={styles.optionText}>Get notes for qualified prospects</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.option}
              onPress={() => addNoteToStageDeals(3, 'Proposal Qualified')}
            >
              <MaterialIcons name="note-add" size={24} color="#9C27B0" />
              <Text style={styles.optionText}>Add Note to Proposal Qualified Deal</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.option}
              onPress={() => {
                setChatHistory(prev => [...prev, { 
                  type: 'user', 
                  content: 'Get organization notes' 
                }]);
                setMessage('Get notes for organization ');
                inputRef.current?.focus();
              }}
            >
              <MaterialIcons name="business" size={24} color="#795548" />
              <Text style={styles.optionText}>Get Organization Notes</Text>
            </TouchableOpacity>
          </View>

          {chatHistory.map((msg, index) => (
            <View 
              key={index} 
              style={[
                styles.message,
                msg.type === 'user' ? styles.userMessage : styles.aiMessage
              ]}
            >
              {msg.type === 'ai' ? (
                <Markdown 
                  style={styles.markdownStyles}
                >{msg.content}</Markdown>
              ) : (
                <Text style={styles.messageText}>{msg.content}</Text>
              )}
            </View>
          ))}
        </ScrollView>

        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            value={message}
            onChangeText={setMessage}
            placeholder="Type a message..."
            placeholderTextColor="#666"
            ref={inputRef}
          />
          <TouchableOpacity 
            style={styles.micButton} 
            onPress={isListening ? stopRecording : startRecording}
          >
            <MaterialIcons 
              name={isListening ? "stop" : "mic"} 
              size={24} 
              color={isListening ? "#FF0000" : "#666"} 
            />
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.sendButton}
            onPress={handleSendMessage}
          >
            <MaterialIcons name="send" size={24} color="#4CAF50" />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
  mainContent: {
    flex: 1,
    padding: 16,
  },
  logoutButton: {
    position: 'absolute',
    top: 40,
    right: 16,
    zIndex: 1,
  },
  header: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: 50,
    marginBottom: 20,
  },
  chatContainer: {
    flex: 1,
    marginBottom: 16,
  },
  optionsContainer: {
    flexDirection: 'column',
    marginBottom: 16,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#222222',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  optionText: {
    color: '#FFFFFF',
    marginLeft: 12,
    fontSize: 16,
  },
  message: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
    maxWidth: '80%',
  },
  userMessage: {
    backgroundColor: '#4CAF50',
    alignSelf: 'flex-end',
  },
  aiMessage: {
    backgroundColor: '#333333',
    alignSelf: 'flex-start',
  },
  messageText: {
    color: '#FFFFFF',
    fontSize: 16,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#222222',
    borderRadius: 25,
    paddingHorizontal: 16,
  },
  input: {
    flex: 1,
    height: 50,
    color: '#FFFFFF',
    fontSize: 16,
  },
  micButton: {
    padding: 8,
    marginRight: 8,
  },
  sendButton: {
    padding: 8,
  },
  markdownStyles: {
    body: {
      color: '#FFFFFF',
    },
    paragraph: {
      color: '#FFFFFF',
      marginVertical: 4,
    },
    list: {
      color: '#FFFFFF',
    },
    listItem: {
      color: '#FFFFFF',
    },
    strong: {
      color: '#FFFFFF',
      fontWeight: 'bold',
    },
  },
});

export default ChatScreen;