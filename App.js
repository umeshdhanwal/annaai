import React, { useState, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import * as WebBrowser from 'expo-web-browser';
import LoginScreen from './screens/LoginScreen';
import ChatScreen from './screens/ChatScreen';
import 'react-native-url-polyfill/auto';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@env';

WebBrowser.maybeCompleteAuthSession();

const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false
  }
});

const App = () => {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const checkUser = async () => {
      try {
        const session = await supabaseClient.auth.session();
        setUser(session?.user ?? null);
      } catch (error) {
        console.error('Error checking user session:', error);
      } finally {
        setInitializing(false);
      }
    };

    checkUser();

    const { data: authListener } = supabaseClient.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      setInitializing(false);
    });

    return () => {
      if (authListener?.unsubscribe) {
        authListener.unsubscribe();
      }
    };
  }, []);

  if (initializing) {
    return null;
  }

  return (
    <View style={styles.container}>
      {!user ? <LoginScreen supabase={supabaseClient} /> : <ChatScreen supabase={supabaseClient} />}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000',
  },
});

export default App;
